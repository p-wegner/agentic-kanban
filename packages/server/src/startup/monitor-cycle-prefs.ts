import { getNumber } from "@agentic-kanban/shared/lib/settings-registry";
import type { MonitorResourceSummary } from "@agentic-kanban/shared/types";
import type { BoardMonitorResourceSnapshot } from "../services/stale-dev-processes.js";

/**
 * #416: fraction of the configured monitor interval a cycle may spend before it stops
 * starting NEW project sub-passes (the carry-over cursor resumes them next cycle). 2/3
 * leaves the remaining third of every interval genuinely idle for interactive traffic —
 * the measured failure mode was cycle duration >= interval at 10 driven projects, which
 * made `cycleInFlight` permanently true and starved the event loop continuously.
 */
const CYCLE_BUDGET_INTERVAL_FRACTION = 2 / 3;

/** Parse a numeric pref; only a finite, strictly positive value counts. */
export function positivePref(prefMap: Map<string, string>, key: string): number | undefined {
  const value = Number(prefMap.get(key));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * #416: global cycle wall-clock budget — 2/3 of the interval by default (pref
 * `monitor_cycle_budget_ms` overrides).
 */
export function resolveCycleBudgetMs(prefMap: Map<string, string>): number {
  const override = positivePref(prefMap, "monitor_cycle_budget_ms");
  if (override !== undefined) return override;
  const intervalMin = getNumber(prefMap, "auto_monitor_interval");
  const effectiveMin = Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin : 4;
  return Math.round(effectiveMin * 60_000 * CYCLE_BUDGET_INTERVAL_FRACTION);
}

/** Summarise (and log) a resource snapshot; null when the sweep produced none. */
export function summarizeResourceSnapshot(snapshot: BoardMonitorResourceSnapshot | null): MonitorResourceSummary | null {
  if (!snapshot) return null;
  const summary: MonitorResourceSummary = {
    processCount: snapshot.processes.length,
    listenerCount: snapshot.listeners.length,
    activeWorkspaceCount: snapshot.activeWorkspaces.length,
    keptCount: snapshot.kept.length,
    cleanedCount: snapshot.cleaned.filter((item) => item.action === "cleaned").length,
    cleanupFailedCount: snapshot.cleaned.filter((item) => item.action === "cleanup_failed").length,
  };
  console.log(
    `[monitor] Resource snapshot: processes=${summary.processCount} listeners=${summary.listenerCount} ` +
    `activeWorkspaces=${summary.activeWorkspaceCount} kept=${summary.keptCount} cleaned=${summary.cleanedCount} failed=${summary.cleanupFailedCount}`,
  );
  return summary;
}
