import { useState } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

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
  closedTickets: number;
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
};

type LoopAdvanceResult = {
  loop: string;
  converged: boolean;
  note: string | null;
  planned: number;
  created: Array<{ unitId: string; issueId: string; issueNumber: number | null; title: string }>;
  skippedExisting: Array<{ unitId: string; issueNumber: number | null; statusName: string }>;
  capped: number;
  startMode: string;
  warnings: string[];
}

type ScriptRunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
type SkillRunResult = { issueId: string; issueNumber: number | null; workspaceId: string; branch: string };

function PaneHeading({ title, subtitle, mono }: { title: string; subtitle?: string | null; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <h2 className={`text-base font-medium text-gray-900 dark:text-gray-100 ${mono ? "font-mono" : ""}`}>{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
    </div>
  );
}

/** Converging analysis loop: advance a round, then let the board's monitor run it. */
export function PluginLoopPane({ loop, projectId, onChanged }: { loop: PluginLoop; projectId: string; onChanged: () => void }) {
  const [advancing, setAdvancing] = useState(false);
  const [result, setResult] = useState<LoopAdvanceResult | null>(null);

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await apiPost<LoopAdvanceResult>(
        `/api/plugins/${loop.pluginId}/loops/${encodeURIComponent(loop.name)}/advance`,
        { projectId },
      );
      setResult(res);
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

  const roundRunning = loop.openTickets > 0;
  return (
    <div className="p-6 space-y-4 overflow-y-auto" data-testid="plugin-loop-pane">
      <PaneHeading title={loop.label} subtitle={loop.description} />

      <p className="text-xs text-gray-500 dark:text-gray-400 max-w-2xl">
        A board-owned loop. Each advance asks the plugin what work is still outstanding and turns every unit
        into a ticket carrying the <span className="font-mono">{loop.skill}</span> skill. The board&apos;s monitor
        starts those tickets within this project&apos;s WIP limit — so they use the same provider selection and
        profile rotation as any other ticket. Once a round&apos;s tickets are all closed the next round is planned
        automatically, until the plugin reports nothing left to do.
      </p>

      <div className="flex items-center gap-4 text-sm">
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.openTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">open tickets</div>
        </div>
        <div className="px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loop.closedTickets}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">closed rounds</div>
        </div>
        <button
          onClick={() => void advance()}
          disabled={advancing}
          className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="plugin-loop-advance"
          title={roundRunning ? "The current round is still running — advancing now plans nothing new" : "Plan the next round"}
        >
          {advancing ? "Planning…" : loop.closedTickets === 0 && loop.openTickets === 0 ? "Start loop" : "Advance now"}
        </button>
      </div>

      {roundRunning && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Round in progress — {loop.openTickets} ticket(s) still open. The next round is planned automatically once they close.
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
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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

/** Judgment-requiring work — launched as a ticket + workspace, not a subprocess. */
export function PluginSkillPane({ skill, projectId }: { skill: PluginSkill; projectId: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SkillRunResult | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    try {
      const res = await apiPost<SkillRunResult>(
        `/api/plugins/${skill.pluginId}/skills/${encodeURIComponent(skill.name)}/run`,
        { projectId },
      );
      setResult(res);
      showToast(`Launched #${res.issueNumber ?? "?"} on ${res.branch}`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Skill run failed", "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-6 space-y-4" data-testid="plugin-skill-pane">
      <PaneHeading title={skill.name} subtitle={skill.description} mono />
      <p className="text-xs text-gray-500 dark:text-gray-400 max-w-2xl">
        Skills need judgment, so running one creates a ticket and launches a workspace against it — the same
        path as any other board work, with the project&apos;s provider selection, review and merge gates.
      </p>
      <button
        onClick={() => void run()}
        disabled={running}
        className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
        data-testid="plugin-skill-run"
      >
        {running ? "Launching…" : "Run as a ticket"}
      </button>
      {result && (
        <p className="text-xs text-gray-600 dark:text-gray-300">
          Launched issue #{result.issueNumber ?? "?"} on <span className="font-mono">{result.branch}</span>
        </p>
      )}
    </div>
  );
}
