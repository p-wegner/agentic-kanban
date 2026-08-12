import { useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { setProjectPref } from "../lib/settingsStore.js";
import {
  ArtifactViewer,
  AwaitingMergeCard,
  ChecksBadges,
  GateCard,
  LoopStateChips,
  LoopTimeline,
  ProgressStepper,
  type LoopStall,
  type PluginCheck,
  type PluginGate,
  type PluginProgressStep,
  type StartPolicy,
} from "./PluginLoopExtras.js";

/**
 * The non-iframe halves of the board's Plugins panel: the panes for a plugin's
 * converging LOOPS, one-shot SCRIPTS, and agentic SKILLS. Split out of
 * PluginViewsPanel so the view host stays about hosting views.
 *
 * All three do the same shape of work (POST, show a result, report an error), but
 * they are deliberately NOT one generic pane: what "success" means differs enough
 * to matter to the user — a loop reports rounds and convergence, a script an exit
 * code and output, a skill a ticket number — and flattening them into a shared
 * result blob is how a UI stops answering the question the user actually has.
 */

export type PluginOwner = {
  /** Plugin DB row id — the `:id` segment of the plugin routes. */
  pluginId: string;
  pluginSlug: string;
  pluginName: string;
};

export type PluginLoop = PluginOwner & {
  name: string;
  label: string;
  description: string | null;
  skill: string;
  openTickets: number;
  /** The open tickets themselves (#429), so the pane can name them rather than only count them. */
  openTicketRefs?: Array<{ issueId: string; issueNumber: number | null; statusName: string }>;
  closedTickets: number;
  paused: boolean;
  converged: boolean;
  note: string | null;
  lastAdvanceAt: string | null;
  gate: PluginGate | null;
  /**
   * When the current gate was first reached. Use this — never `lastAdvanceAt` — to show how
   * long a decision has been waiting: the monitor re-plans a gated loop every cycle, so
   * `lastAdvanceAt` keeps moving while nobody has acted.
   */
  gateSince?: string | null;
  progress: { steps: PluginProgressStep[] } | null;
  checks: PluginCheck[] | null;
  totalCostUsd?: number;
  /**
   * Finished-but-unlanded loop ticket (#299) — the silent-stall state, now named. Since #363 it
   * also carries a workspace parked `ready_for_merge` whose issue never advanced; check
   * `mergeSafe` before offering to land it.
   */
  awaitingMerge?: LoopStall | null;
  /** The butler's pre-read verdict for the current gate (#309). */
  gateRecommendation?: { actionId: string; reason: string } | null;
};

export type PluginScript = PluginOwner & {
  name: string;
  label: string;
  description: string | null;
  command: string;
};

export type PluginSkill = PluginOwner & {
  name: string;
  description: string | null;
  /** Workflow the manifest declares for this skill (builtin key or name); null = board default. */
  workflow?: string | null;
};

type WorkflowTemplate = {
  id: string;
  name: string;
  description: string | null;
  builtinKey: string | null;
  isDefault: boolean;
  ticketType: string | null;
};

type LoopAdvanceResult = {
  loop: string;
  converged: boolean;
  note: string | null;
  planned: number;
  created: Array<{ unitId: string; issueId: string; issueNumber: number | null; title: string; artifacts?: string[] }>;
  skippedExisting: Array<{ unitId: string; issueNumber: number | null; statusName: string }>;
  capped: number;
  startMode: string;
  warnings: string[];
}

type ScriptRunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
type SkillRunResult = { issueId: string; issueNumber: number | null; workspaceId: string; branch: string };

/** Mirrors the server's PluginSkillRunProgress (plugin.service.ts). */
type SkillRunProgress =
  | { stage: "ticket"; issueId: string; issueNumber: number | null; title: string }
  | { stage: "workspace"; issueId: string; issueNumber: number | null; setupScript: string | null }
  | ({ stage: "done" } & SkillRunResult)
  | { stage: "error"; message: string };

function PaneHeading({ title, subtitle, mono }: { title: string; subtitle?: string | null; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <h2 className={`text-base font-medium text-gray-900 dark:text-gray-100 ${mono ? "font-mono" : ""}`}>{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
    </div>
  );
}

/** Converging analysis loop: advance a round, then let the board's monitor run it. */
export function PluginLoopPane({ loop, projectId, onChanged, startPolicy = null, setupRequired = null }: {
  loop: PluginLoop;
  projectId: string;
  onChanged: () => void;
  startPolicy?: StartPolicy;
  /**
   * Set when the plugin's scaffold still has unresolved TODO markers (#427). Every advance
   * 409s in that state, so the pane must say so BEFORE the click rather than only in the
   * toast afterwards — on a fresh project this pane opened with "Start loop" as the primary
   * action when refusal was the only possible outcome.
   */
  setupRequired?: { pendingFields: number; targetPath: string; onOpenSetup: () => void } | null;
}) {
  const [advancing, setAdvancing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [result, setResult] = useState<LoopAdvanceResult | null>(null);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  /**
   * The step the open artifact came from (#422/#423) — supplies the viewer's header and
   * its sibling picker. Null when the artifact was opened from the gate card or the unit
   * list, which are per-file and carry no step.
   */
  const [openArtifactStep, setOpenArtifactStep] = useState<
    { label: string; version?: string; artifacts?: string[]; index: number; total: number } | null
  >(null);
  const [timelineKey, setTimelineKey] = useState(0);
  // Line-anchored review notes collected on the artifact diff (#304).
  const [lineNotes, setLineNotes] = useState<string[]>([]);
  const [switchingMode, setSwitchingMode] = useState(false);

  /**
   * One-click fix for the manual-Start-Mode warning (#428): the loop planned tickets that
   * nothing will start. Writes the same `start_mode` project preference the Monitor view's
   * control writes. It deliberately does NOT touch the Conductor: this only ever moves
   * manual → monitor, and a project in manual has no conductor loop running to stop.
   */
  async function switchToMonitorMode() {
    if (switchingMode) return;
    setSwitchingMode(true);
    try {
      await setProjectPref(projectId, "start_mode", "monitor");
      showToast("Start Mode set to monitor — the board will start this loop's tickets", "success");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change Start Mode", "error");
    } finally {
      setSwitchingMode(false);
    }
  }

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await apiPost<LoopAdvanceResult>(
        `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/advance`,
        { projectId },
      );
      setResult(res);
      setTimelineKey((k) => k + 1);
      showToast(
        res.created.length > 0
          ? `Planned ${res.created.length} ticket(s) for "${loop.label}"`
          : res.converged
            ? `"${loop.label}" has converged`
            : `No new work for "${loop.label}"`,
        "success",
      );
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Loop advance failed", "error");
    } finally {
      setAdvancing(false);
    }
  }

  async function togglePause() {
    if (pausing) return;
    setPausing(true);
    try {
      await apiPost(
        `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/${loop.paused ? "resume" : "pause"}`,
        { projectId },
      );
      showToast(loop.paused ? `"${loop.label}" resumed` : `"${loop.label}" paused`, "success");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Loop pause/resume failed", "error");
    } finally {
      setPausing(false);
    }
  }

  const roundRunning = loop.openTickets > 0;
  return (
    <div className="p-3 sm:p-6 space-y-4 overflow-y-auto" data-testid="plugin-loop-pane">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3">
        <PaneHeading title={loop.label} subtitle={loop.description} />
        <LoopStateChips
          loop={loop}
          startPolicy={startPolicy}
          onSwitchToMonitor={() => void switchToMonitorMode()}
          switchingMode={switchingMode}
        />
      </div>

      {/* Setup gate (#427): the server 409s every advance while the scaffold has unresolved
          markers, so say it here — persistently — instead of only in the toast after the click. */}
      {setupRequired && (
        <div
          className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 max-w-2xl flex items-start gap-2"
          data-testid="plugin-loop-setup-required"
        >
          <span aria-hidden="true">🛠️</span>
          <div className="flex-1 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-medium">Setup required before this loop can run.</span>{" "}
            {setupRequired.pendingFields} unanswered field{setupRequired.pendingFields === 1 ? "" : "s"} in{" "}
            <span className="font-mono">{setupRequired.targetPath}</span> — the plugin&apos;s agents work from
            that profile, so every advance is refused until it is filled in.
          </div>
          <button
            type="button"
            onClick={setupRequired.onOpenSetup}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200"
          >
            Fill it in
          </button>
        </div>
      )}
      {/* Collapsed by default: this is unchanging documentation of how loops work in general,
          identical on every loop and every visit, and it cost ~90px at the top of the pane —
          which pushed the gate's ACTION BUTTONS below the fold on a 720px viewport. The thing
          the reader came for (the gate, its verdict, its buttons) outranks the explainer. */}
      <details className="max-w-2xl">
        <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
          How this loop works
        </summary>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          A board-owned loop. Each advance asks the plugin what work is still outstanding and turns every unit
          into a ticket carrying the <span className="font-mono">{loop.skill}</span> skill. The board&apos;s monitor
          starts those tickets within this project&apos;s WIP limit — so they use the same provider selection and
          profile rotation as any other ticket. Once a round&apos;s tickets are all closed the next round is planned
          automatically, until the plugin reports nothing left to do — or until the loop is paused.
        </p>
      </details>

      {/* Declarative pipeline progress (#289) + verification badges (#290). */}
      <ProgressStepper
        steps={loop.progress?.steps}
        activePath={openArtifact}
        onOpenStep={(step, index, total) => {
          setOpenArtifact(step.artifacts![0]);
          setOpenArtifactStep({ label: step.label, version: step.version, artifacts: step.artifacts, index, total });
        }}
      />
      <ChecksBadges checks={loop.checks} />

      {/* A finished step whose merge hasn't landed (#299) — the loop's silent-stall state. */}
      {loop.awaitingMerge && (
        <AwaitingMergeCard awaitingMerge={loop.awaitingMerge} onMergeStarted={onChanged} />
      )}

      {/* The human gate (#286): the single thing this loop needs from a person right now. */}
      {loop.gate && loop.openTickets === 0 && (
        <GateCard
          pluginId={loop.pluginId}
          loopName={loop.name}
          projectId={projectId}
          gate={loop.gate}
          gateSince={loop.gateSince ?? null}
          checks={loop.checks}
          recommendation={loop.gateRecommendation ?? null}
          lineNotes={lineNotes}
          onOpenArtifact={(p) => { setOpenArtifact(p); setOpenArtifactStep(null); }}
          onResolved={() => { setTimelineKey((k) => k + 1); setLineNotes([]); onChanged(); }}
        />
      )}
      {!loop.gate && loop.note && loop.openTickets === 0 && !loop.converged && (
        <p className="text-xs text-amber-700 dark:text-amber-400 max-w-2xl" data-testid="plugin-loop-note">
          {loop.note}
        </p>
      )}

      {/* wraps below sm: three stat boxes + Advance + Pause cannot share a phone line (#433) */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-sm">
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.openTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">open tickets</div>
        </div>
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.closedTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">closed rounds</div>
        </div>
        {(loop.totalCostUsd ?? 0) > 0 && (
          <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700" data-testid="plugin-loop-cost">
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">${loop.totalCostUsd!.toFixed(2)}</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">agent cost so far</div>
          </div>
        )}
        <button
          onClick={() => void advance()}
          disabled={advancing || !!setupRequired}
          className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="plugin-loop-advance"
          title={setupRequired
            ? `Fill in the ${setupRequired.pendingFields} outstanding profile field(s) first — the plugin refuses to plan without them`
            : roundRunning
              ? "The current round is still running — advancing now plans nothing new"
              : "Plan the next round"}
        >
          {advancing ? "Planning…" : loop.closedTickets === 0 && loop.openTickets === 0 ? "Start loop" : "Advance now"}
        </button>
        <button
          onClick={() => void togglePause()}
          disabled={pausing}
          className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="plugin-loop-pause-toggle"
          title={loop.paused
            ? "Resume — the monitor will auto-advance this loop again"
            : "Pause — stops the monitor from auto-advancing this loop; manual Advance still works"}
        >
          {pausing ? "Working…" : loop.paused ? "Resume" : "Pause"}
        </button>
      </div>

      {roundRunning && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="plugin-loop-round-running">
          Round in progress — {loop.openTickets} ticket(s) still open
          {/* NAME the open tickets and their live status (#429). "1 ticket(s) still open" left the
              reader to go to the board and work out which one and whether it had actually started —
              the difference between "running" and "planned but nothing is provisioning it" is
              exactly what stalls here look like. The refs cost no extra query. */}
          {(loop.openTicketRefs?.length ?? 0) > 0 && (
            <>
              {": "}
              {loop.openTicketRefs!.map((ref, i) => (
                <span key={ref.issueId}>
                  {i > 0 && ", "}
                  <span className="font-mono">#{ref.issueNumber ?? "?"}</span>
                  <span className="opacity-75"> ({ref.statusName})</span>
                </span>
              ))}
            </>
          )}
          . The next round is planned automatically once they close.
        </p>
      )}
      {loop.paused && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Paused — the monitor will not auto-advance this loop. Press Resume to let it converge hands-off again.
        </p>
      )}

      {result && (
        <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
          <div className="text-sm text-gray-800 dark:text-gray-200">
            {result.converged && result.created.length === 0
              ? "Converged — the plugin reports no outstanding work."
              : `Planned ${result.planned} unit(s): ${result.created.length} new ticket(s), ${result.skippedExisting.length} already ticketed.`}
          </div>
          {result.note && <div className="text-xs text-gray-500 dark:text-gray-400">{result.note}</div>}
          {result.warnings.map((warning) => (
            <div key={warning} className="text-xs text-amber-700 dark:text-amber-400">⚠ {warning}</div>
          ))}
          {result.created.length > 0 && (
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
              {result.created.map((unit) => (
                <li key={unit.issueId}>
                  <span className="font-mono text-gray-400 dark:text-gray-500">#{unit.issueNumber ?? "?"}</span> {unit.title}
                  {(unit.artifacts?.length ?? 0) > 0 && (
                    <span className="ml-1">
                      {unit.artifacts!.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => { setOpenArtifact(path); setOpenArtifactStep(null); }}
                          className="text-[11px] font-mono text-brand-600 dark:text-brand-400 hover:underline ml-1"
                        >
                          📄 {path.split("/").pop()}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Inline artifact viewer (#288) — opened from the gate card, stepper, or unit list. */}
      {openArtifact && (
        <ArtifactViewer
          pluginId={loop.pluginId}
          loopName={loop.name}
          projectId={projectId}
          path={openArtifact}
          step={openArtifactStep ?? undefined}
          onOpenArtifact={setOpenArtifact}
          onClose={() => { setOpenArtifact(null); setOpenArtifactStep(null); }}
          onLineNotesChange={setLineNotes}
        />
      )}

      <LoopTimeline pluginId={loop.pluginId} loopName={loop.name} projectId={projectId} refreshKey={timelineKey} />
    </div>
  );
}

/** One-shot deterministic subprocess. */
export function PluginScriptPane({ script, projectId }: { script: PluginScript; projectId: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ScriptRunResult | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    try {
      const res = await apiPost<ScriptRunResult>(
        `/api/plugins/${script.pluginId}/scripts/${encodeURIComponent(script.name)}/run`,
        { projectId },
      );
      setResult(res);
      if (res.timedOut) showToast(`"${script.label}" timed out`, "error");
      else if (res.code !== 0) showToast(`"${script.label}" exited ${res.code}`, "error");
      else showToast(`"${script.label}" finished`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Script run failed", "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-6 space-y-4 min-h-0 flex flex-col" data-testid="plugin-script-pane">
      <PaneHeading title={script.label} subtitle={script.description} />
      <div className="flex items-center gap-2">
        <code className="text-[11px] px-2 py-1 rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 truncate flex-1">
          {script.command}
        </code>
        <button
          onClick={() => void run()}
          disabled={running}
          className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 shrink-0"
          data-testid="plugin-script-run"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
      {result && (
        <div className="flex-1 min-h-0 flex flex-col gap-1">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {result.timedOut ? "Timed out" : `Exit code ${result.code ?? "?"}`}
            {result.code === 0 && !result.timedOut ? " ✓" : ""}
          </div>
          <pre className="flex-1 min-h-0 p-3 rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-auto whitespace-pre-wrap break-all text-[11px] text-gray-700 dark:text-gray-300">
            {[
              result.stdout && `── stdout ──\n${result.stdout}`,
              result.stderr && `── stderr ──\n${result.stderr}`,
            ].filter(Boolean).join("\n\n") || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Seconds since a start timestamp, ticking once a second while a launch is in flight. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
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
        if (!cancelled) setTemplatesError(err instanceof Error ? err.message : String(err));
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
      // (client/CLAUDE.md). Each `data:` line is one stage of the launch.
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
    <div className="p-6 space-y-4 overflow-auto" data-testid="plugin-skill-pane">
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
            className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
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
            className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 font-mono text-[12px] disabled:opacity-50"
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
            className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 disabled:opacity-50"
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
        className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
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
