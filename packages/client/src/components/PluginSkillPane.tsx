import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { PaneHeading } from "./PluginActionPanes.js";
import type { PluginSkill } from "./PluginActionPanes.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { useNow } from "../hooks/usePoll.js";

/**
 * Judgment-requiring plugin work, launched as a ticket + workspace (#465: split out of
 * PluginActionPanes.tsx to keep that file under the god-module line ceiling).
 */

type WorkflowTemplate = {
  id: string;
  name: string;
  description: string | null;
  builtinKey: string | null;
  isDefault: boolean;
  ticketType: string | null;
};

type SkillRunResult = { issueId: string; issueNumber: number | null; workspaceId: string; branch: string };

/** Mirrors the server's PluginSkillRunProgress (plugin.service.ts). */
type SkillRunProgress =
  | { stage: "ticket"; issueId: string; issueNumber: number | null; title: string }
  | { stage: "workspace"; issueId: string; issueNumber: number | null; setupScript: string | null }
  | ({ stage: "done" } & SkillRunResult)
  | { stage: "error"; message: string };

/** Seconds since a start timestamp, ticking once a second while a launch is in flight. */
function useElapsed(since: number | null): number {
  const now = useNow(1000, since !== null);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

/**
 * Judgment-requiring work — launched as a ticket + workspace, not a subprocess.
 *
 * Two things this pane has to get right, both learned the hard way:
 *
 * 1. **Most skills need more than their name.** "Run requirement-extraction" is rarely the whole
 *    instruction; the launcher usually knows which module, which lens, which constraint. That text
 *    has nowhere to go unless the launch offers it, so the pane takes a title and a free-text
 *    prompt and the server appends the prompt to the skill's brief.
 *
 * 2. **The launch takes MINUTES and the ticket appears in MILLISECONDS.** Provisioning is worktree
 *    → the project's setup script (`npm install`, often the bulk of it) → agent launch, all inside
 *    one request. The old pane awaited that single request behind a "Launching…" label, so for
 *    minutes there was no ticket number, no stage, no error surface — indistinguishable from a
 *    dead button, while the ticket had in fact been on the board since the first second. It now
 *    streams the server's progress and shows each stage as it lands.
 */
export function PluginSkillPane({ skill, projectId }: { skill: PluginSkill; projectId: string }) {
  const [running, setRunning] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [progress, setProgress] = useState<SkillRunProgress[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflowTemplateId, setWorkflowTemplateId] = useState("");
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const elapsed = useElapsed(running ? startedAt : null);

  // The workflow decides whether this ticket has to pass a review gate to reach done. A skill
  // that only writes analysis docs has nothing to review, so being silently routed through the
  // board's implement → review → done default parks it on a gate that can only rubber-stamp it.
  useEffect(() => {
    let cancelled = false;
    setTemplatesError(null);
    apiFetch<WorkflowTemplate[]>(`/api/workflows/templates?projectId=${projectId}`)
      .then((rows) => { if (!cancelled) setTemplates(rows); })
      // Don't swallow this. The launch still works — it falls back to the board default — but a
      // selector silently offering one option looks like the board HAS one workflow, which is a
      // different and wrong message.
      .catch((err) => {
        if (!cancelled) setTemplatesError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [projectId]);

  // Reset the choice when switching skills so one skill's pick can't leak onto another.
  useEffect(() => { setWorkflowTemplateId(""); }, [skill.pluginId, skill.name]);

  const declared = skill.workflow
    ? templates.find((t) => t.builtinKey === skill.workflow || t.name.toLowerCase() === skill.workflow!.toLowerCase())
    : undefined;
  const boardDefault = templates.find((t) => t.isDefault && !t.ticketType);

  const ticket = progress.find((p) => p.stage === "ticket");
  const workspaceStage = progress.find((p) => p.stage === "workspace");
  const done = progress.find((p) => p.stage === "done");
  const failed = progress.find((p) => p.stage === "error");

  async function run() {
    if (running) return;
    setRunning(true);
    setProgress([]);
    setStartedAt(Date.now());
    try {
      // SSE over POST must be read with fetch + ReadableStream — EventSource is GET-only
      // (client/CLAUDE.md). Each `data:` line is one stage of the launch. The no-raw-fetch
      // rule exists to route READS through a data-layer hook so they are cached and
      // cancellable; a streaming POST is neither, so the rule has nothing to offer here.
      // eslint-disable-next-line no-restricted-syntax
      const resp = await fetch(
        `/api/plugins/${skill.pluginId}/skills/${encodeURIComponent(skill.name)}/run?stream=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            title: title.trim() || undefined,
            prompt: prompt.trim() || undefined,
            workflowTemplateId: workflowTemplateId || undefined,
          }),
        },
      );
      if (!resp.ok || !resp.body) throw new Error(`Launch failed (${resp.status})`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as SkillRunProgress;
          setProgress((prev) => [...prev, event]);
          if (event.stage === "done") {
            showToast(`Launched #${event.issueNumber ?? "?"} on ${event.branch}`, "success");
            setPrompt("");
            setTitle("");
          }
          if (event.stage === "error") showToast(event.message, "error");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Skill run failed";
      setProgress((prev) => [...prev, { stage: "error", message }]);
      showToast(message, "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-3 sm:p-6 space-y-4 overflow-auto" data-testid="plugin-skill-pane">
      <PaneHeading title={skill.name} subtitle={skill.description} mono />
      <p className="text-xs text-gray-500 dark:text-gray-400 max-w-2xl">
        Skills need judgment, so running one creates a ticket and launches a workspace against it — the same
        path as any other board work, with the project&apos;s provider selection, review and merge gates.
      </p>

      <div className="space-y-3 max-w-2xl">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Ticket title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={running}
            placeholder={`${skill.pluginName}: run ${skill.name}`}
            className="w-full text-base sm:text-sm px-2 py-2 sm:py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
            data-testid="plugin-skill-title"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Additional context <span className="font-normal text-gray-500 dark:text-gray-400">(optional)</span>
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running}
            rows={5}
            placeholder="What should this run focus on? e.g. which module, which lens, which constraint — anything the skill's own brief cannot know."
            className="w-full text-base sm:text-sm px-2 py-2 sm:py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 font-mono sm:text-[12px] disabled:opacity-50"
            data-testid="plugin-skill-prompt"
          />
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            Appended to the skill&apos;s brief in the ticket the agent reads.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Workflow</span>
          <select
            value={workflowTemplateId}
            onChange={(e) => setWorkflowTemplateId(e.target.value)}
            disabled={running || templates.length === 0}
            className="w-full text-base sm:text-sm px-2 py-2 sm:py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
            data-testid="plugin-skill-workflow"
          >
            <option value="">
              {declared
                ? `${declared.name} — declared by this plugin`
                : boardDefault
                  ? `${boardDefault.name} — this board's default`
                  : "Board default"}
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <span className={`text-[11px] ${templatesError ? "text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>
            {templatesError
              ? `Could not load this project's workflows (${templatesError}) — the launch will use the board default.`
              : declared?.description
                ?? boardDefault?.description
                ?? "Decides which gates this ticket passes on its way to done — including whether it needs a review."}
          </span>
        </label>
      </div>

      <button
        onClick={() => void run()}
        disabled={running}
        className="text-sm px-4 py-2.5 sm:px-3 sm:py-1.5 min-h-11 sm:min-h-0 w-full sm:w-auto rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
        data-testid="plugin-skill-run"
      >
        {running ? "Launching…" : "Run as a ticket"}
      </button>

      {progress.length > 0 && (
        <div
          className="max-w-2xl text-xs rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-3 space-y-1.5"
          data-testid="plugin-skill-progress"
        >
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span>{failed ? "Launch failed" : done ? "Launched" : "Launching…"}</span>
            {running && <span className="tabular-nums">{elapsed}s</span>}
          </div>
          {ticket && ticket.stage === "ticket" && (
            <div className="text-gray-700 dark:text-gray-300">
              ✓ Ticket <span className="font-medium">#{ticket.issueNumber ?? "?"}</span> created — it is on the
              board now, even while the rest of this runs.
            </div>
          )}
          {workspaceStage && workspaceStage.stage === "workspace" && (
            <div className={done ? "text-gray-700 dark:text-gray-300" : "text-gray-600 dark:text-gray-400"}>
              {done ? "✓" : "…"} Creating the worktree
              {workspaceStage.setupScript
                ? <> and running the project&apos;s setup script (<span className="font-mono">{workspaceStage.setupScript}</span>){done ? "" : " — this is usually the slow part, often a few minutes"}</>
                : null}
              , then launching the agent.
            </div>
          )}
          {done && done.stage === "done" && (
            <div className="text-gray-700 dark:text-gray-300">
              ✓ Workspace ready on <span className="font-mono">{done.branch}</span> — the agent is running.
            </div>
          )}
          {failed && failed.stage === "error" && (
            <div className="text-red-600 dark:text-red-400">✕ {failed.message}</div>
          )}
        </div>
      )}
    </div>
  );
}
