import type { PluginProgressStep } from "./PluginLoopExtras.js";

// ── Pipeline stepper (#289) ───────────────────────────────────────────
//
// Split out of PluginLoopExtras.tsx (#465) so #464's generic-stepper reuse and
// the god-module gate both get a small, focused file instead of colliding in
// a 1900-line one.

const STEP_MARK: Record<PluginProgressStep["state"], string> = {
  "done": "✓",
  "generating": "⟳",
  "awaiting-approval": "👁",
  "needs-revision": "✎",
  // #453 — `locked` and `pending` both used to be `·` in near-identical grey, so "blocked
  // behind an approval" and "not started" were indistinguishable. That is the difference
  // between WAIT and ACT, and it is the first thing this strip has to answer.
  "locked": "🔒",
  "failed": "✕",
  "pending": "○",
  // #481 — ticketed, no workspace ever provisioned. Distinct from "pending" (no ticket at all
  // yet) so the reader can tell "the loop planned this" from "the loop hasn't reached it".
  "planned": "○",
  // #479 — a workspace ran and exited with nothing to show for it. Never the spinner: the
  // agent is gone, so drawing "running" here is the exact false signal this ticket was filed
  // for. Shares the failed glyph/tone family — this IS a failure the loop cannot recover from
  // on its own — but keeps its own label so "stalled" isn't misread as "failed".
  "stalled": "⚠",
};

const STEP_TONE: Record<PluginProgressStep["state"], string> = {
  "done": "border-green-300 dark:border-green-800 text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-900/20",
  "generating": "border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20",
  "awaiting-approval": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "needs-revision": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "locked": "border-gray-200 border-dashed dark:border-gray-700 text-gray-400 dark:text-gray-500 bg-gray-50/60 dark:bg-gray-800/30",
  "failed": "border-red-300 dark:border-red-800 text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-900/20",
  "pending": "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-transparent",
  "planned": "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-transparent",
  "stalled": "border-red-300 dark:border-red-800 text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-900/20",
};

/** What each state means, spelled out — the glyph alone is a legend nobody has. */
const STEP_STATE_TEXT: Record<PluginProgressStep["state"], string> = {
  "done": "done",
  "generating": "running",
  "awaiting-approval": "waiting on you",
  "needs-revision": "needs revision",
  "locked": "locked — waiting on an earlier step",
  "failed": "failed",
  "pending": "not started",
  "planned": "planned — not started yet",
  "stalled": "stalled — agent exited, nothing landed",
};

export type LoopUnitCost = { unitId: string; costUsd: number; sessions: number };

/**
 * The cost of a step, joined from the loop's per-unit cost (#453).
 *
 * Unit ids are `step-<n>:v<m>`, so they join to steps by their prefix — and the versions a
 * step has been through are visible in that join, which is also the only place the UI can see
 * that a step now on v3 ever HAD a v1.
 */
export function stepCost(stepId: string, byUnit?: LoopUnitCost[] | null): {
  totalUsd: number;
  sessions: number;
  versions: LoopUnitCost[];
} | null {
  const versions = (byUnit ?? []).filter((u) => u.unitId.split(":")[0] === stepId);
  if (versions.length === 0) return null;
  return {
    totalUsd: versions.reduce((sum, u) => sum + u.costUsd, 0),
    sessions: versions.reduce((sum, u) => sum + u.sessions, 0),
    versions: [...versions].sort((a, b) => a.unitId.localeCompare(b.unitId)),
  };
}

/**
 * One row per pipeline step, with the state spelled out, the version, the cost, and every
 * artifact as its own chip (#453). See PluginLoopExtras.tsx history for the wrapping-pill-row
 * layout this replaced.
 */
export function ProgressStepper({ steps, activePath, costByUnit, onOpenStep, onOpenStepArtifact, onStartStep, startingStepId }: {
  steps: PluginProgressStep[] | undefined;
  /** Path currently open in the viewer — keeps its row visibly selected (#423). */
  activePath?: string | null;
  /**
   * Per-unit agent cost, as the events endpoint returns it (#453). Optional: without it the
   * strip simply shows no money, exactly as before.
   */
  costByUnit?: LoopUnitCost[] | null;
  /** Reports the whole step, not just a path, so the viewer can show step context
   *  and offer the step's OTHER artifacts (#422). */
  onOpenStep: (step: PluginProgressStep, index: number, total: number) => void;
  /**
   * Open ONE named artifact of a step. Optional; without it an artifact chip falls back to
   * `onOpenStep`, which opens the step's first artifact and leaves the rest to the sibling
   * picker (#422).
   */
  onOpenStepArtifact?: (step: PluginProgressStep, path: string, index: number, total: number) => void;
  /**
   * Start the step's ticket (#481). Optional — without it the step still SAYS "planned", it
   * just cannot be acted on from here, which is the pre-#481 behaviour.
   *
   * The complaint this closes: the panel said "generating" while a notice on the same screen
   * said the ticket would not start on its own, and the only offered remedies were to go find
   * the ticket on the board or change Start Mode in another view. The step card — where the
   * user is actually looking — offered nothing.
   */
  onStartStep?: (step: PluginProgressStep) => void;
  /** The step whose start is in flight, so its button can disable itself. */
  startingStepId?: string | null;
}) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="max-w-3xl space-y-0.5" data-testid="plugin-loop-stepper">
      {steps.map((step, i) => {
        const artifacts = step.artifacts ?? [];
        const clickable = artifacts.length > 0;
        const isActive = !!activePath && artifacts.includes(activePath);
        const cost = stepCost(step.id, costByUnit);
        return (
          <li
            key={step.id}
            data-testid={`plugin-loop-step-${step.id}`}
            data-step-state={step.state}
            aria-current={isActive ? "true" : undefined}
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded border px-2 py-1 ${STEP_TONE[step.state]} ${
              isActive ? "ring-2 ring-brand-400 ring-offset-1 dark:ring-offset-gray-900" : ""
            }`}
          >
            <span className="w-4 shrink-0 text-center text-[11px]" aria-hidden="true">{STEP_MARK[step.state]}</span>
            <span className="w-8 shrink-0 text-[10px] tabular-nums opacity-60">{i + 1}/{steps.length}</span>
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onOpenStep(step, i + 1, steps.length)}
              title={clickable
                ? `${step.label} — ${STEP_STATE_TEXT[step.state]}\nClick to open ${artifacts.length === 1 ? "the artifact" : `its ${artifacts.length} artifacts`}`
                : `${step.label} — ${STEP_STATE_TEXT[step.state]}`}
              className={`min-w-0 flex-1 truncate text-left text-[11px] ${clickable ? "hover:underline cursor-pointer" : "cursor-default"}`}
            >
              {step.label}
            </button>
            {step.version && <span className="shrink-0 text-[10px] opacity-70">{step.version}</span>}
            {/* The step's cost, joined from `byUnit` — it was already being fetched for the
                timeline a few hundred pixels below, and attaching it here is free. */}
            {cost && (
              <span
                className="shrink-0 text-[10px] tabular-nums opacity-70"
                data-testid={`plugin-loop-step-cost-${step.id}`}
                title={cost.versions.map((v) => `${v.unitId}: $${v.costUsd.toFixed(2)} (${v.sessions} session${v.sessions === 1 ? "" : "s"})`).join("\n")}
              >
                ${cost.totalUsd.toFixed(2)}
              </span>
            )}
            <span className="shrink-0 text-[10px] opacity-60">{STEP_STATE_TEXT[step.state]}</span>
            {/* #481 — the missing affordance. Only for `planned`: a `stalled` step already has
                a workspace, so starting a second one is not the remedy (that is the loop-stall
                card's job). */}
            {onStartStep && step.state === "planned" && step.ticket && (
              <button
                type="button"
                data-testid={`plugin-loop-step-start-${step.id}`}
                disabled={startingStepId === step.id}
                onClick={() => onStartStep(step)}
                title={`Start #${step.ticket.issueNumber ?? "?"} — creates a workspace and launches the agent for this step`}
                className="shrink-0 rounded border border-brand-300 px-1.5 py-0.5 text-[10px] text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-900/30"
              >
                {startingStepId === step.id ? "Starting…" : `Start #${step.ticket.issueNumber ?? "?"}`}
              </button>
            )}
            {/* Every artifact reachable without opening one first (#422/#453): a step with
                three outputs used to advertise `📄3` and open only the first. */}
            {artifacts.map((artifactPath) => (
              <button
                key={artifactPath}
                type="button"
                onClick={() => (onOpenStepArtifact
                  ? onOpenStepArtifact(step, artifactPath, i + 1, steps.length)
                  : onOpenStep(step, i + 1, steps.length))}
                title={artifactPath}
                aria-current={activePath === artifactPath ? "true" : undefined}
                className={`shrink-0 rounded border px-1.5 py-2 sm:py-0 min-h-11 sm:min-h-0 text-[10px] font-mono ${
                  activePath === artifactPath
                    ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                    : "border-current/30 opacity-70 hover:opacity-100"
                }`}
              >
                📄 {artifactPath.split("/").pop()}
              </button>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
