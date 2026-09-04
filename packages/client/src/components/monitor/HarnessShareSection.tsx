/**
 * Monitor view: the weekly harness share (#1021, rendered by #1032).
 *
 * `GET /api/internal/monitor-status` has carried `harnessShare` since #1021 — the share of
 * tickets that reached Done in the last 7 days carrying the `harness` tag — but nothing drew
 * it, so the number the harness-budget rule is ABOUT was invisible in the very view where the
 * budget's skip reason shows up. This puts it next to the configured `Harness %` (the Strategy
 * Bullseye's `harnessSharePct`, resolved through `/api/board-monitor/tunables`) so an operator
 * can read "what landed" against "what is allowed" in one line.
 *
 * Own module, like `ProfileQuotaSection`: `MonitorSections.tsx` sits at the 1000-line
 * god-module ceiling. The pure `*Body` half (#611) takes only the two values so it can be
 * asserted without a fetch; the popover already holds both.
 */
import type { MonitorStatus } from "../../lib/monitor-popover.js";

type HarnessShare = NonNullable<MonitorStatus["harnessShare"]>;

export function HarnessShareSection({
  harnessShare,
  configuredPct,
}: {
  harnessShare: HarnessShare | null | undefined;
  /** The Bullseye's `harnessSharePct`, or null when the tunables have not resolved yet. */
  configuredPct: number | null;
}) {
  return <HarnessShareBody harnessShare={harnessShare ?? null} configuredPct={configuredPct} />;
}

/**
 * The pure half. `sharePct === null` means nothing landed in the window — the endpoint is
 * explicit that this is not the same answer as 0 %, so it renders as "no tickets landed"
 * rather than a misleading zero. A null `harnessShare` (read-off failed server-side) renders
 * nothing: an always-present empty section is noise in a popover whose other sections appear
 * only when they have content.
 */
export function HarnessShareBody({
  harnessShare,
  configuredPct,
}: {
  harnessShare: HarnessShare | null;
  configuredPct: number | null;
}) {
  if (!harnessShare) return null;
  const { doneCount, harnessCount, sharePct, windowDays } = harnessShare;
  const windowLabel = windowDays === 7 ? "this week" : `last ${windowDays} days`;
  const overBudget = sharePct !== null && configuredPct !== null && sharePct > configuredPct;

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800" data-testid="harness-share-section">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">
        Harness share
      </div>
      <div
        className="flex items-center justify-between gap-2 rounded-md bg-gray-50 dark:bg-gray-800 px-2 py-1"
        title={`${harnessCount} of ${doneCount} ticket(s) that reached Done in the last ${windowDays} days carried the "harness" tag. Budget = Strategy Bullseye → Harness %.`}
      >
        <div className="text-gray-700 dark:text-gray-300">
          harness share {windowLabel}:{" "}
          {sharePct === null ? (
            <span className="text-gray-400 dark:text-gray-500">no tickets landed</span>
          ) : (
            <span className={`font-mono font-semibold ${overBudget ? "text-amber-700 dark:text-amber-300" : ""}`}>
              {sharePct} %
            </span>
          )}
          {sharePct !== null && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500"> ({harnessCount}/{doneCount})</span>
          )}
        </div>
        <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500" title="Configured harness budget (Strategy Bullseye → Harness %)">
          budget {configuredPct === null ? "—" : `${configuredPct} %`}
        </span>
      </div>
    </div>
  );
}
