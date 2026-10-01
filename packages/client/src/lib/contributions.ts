import type { ContributionActorRow } from "@agentic-kanban/shared";

/** Pure core of the Contributions view (#1264): range <-> URL, sorting, formatting. */

export type ContributionRange = "7d" | "30d" | "all" | "custom";

export const CONTRIBUTION_RANGES: readonly { id: ContributionRange; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

export interface RangeSelection {
  range: ContributionRange;
  /** `YYYY-MM-DD`, only meaningful for `custom`. */
  customFrom: string;
  customTo: string;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Read `?range=&from=&to=`; anything unknown falls back to "all". */
export function parseRangeSearch(search: string): RangeSelection {
  const params = new URLSearchParams(search);
  const raw = params.get("range");
  const range = CONTRIBUTION_RANGES.some((r) => r.id === raw) ? (raw as ContributionRange) : "all";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  return {
    range,
    customFrom: DATE_ONLY.test(from) ? from : "",
    customTo: DATE_ONLY.test(to) ? to : "",
  };
}

/** Write the selection into an existing search string, preserving unrelated params. */
export function buildRangeSearch(currentSearch: string, selection: RangeSelection): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("range");
  params.delete("from");
  params.delete("to");
  if (selection.range !== "all") params.set("range", selection.range);
  if (selection.range === "custom") {
    if (selection.customFrom) params.set("from", selection.customFrom);
    if (selection.customTo) params.set("to", selection.customTo);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The server window for a selection. Preset lower bounds snap to the start of the UTC day so
 * the value (and therefore the query key and the server's ETag) is stable all day.
 */
export function resolveRangeWindow(
  selection: RangeSelection,
  nowMs: number,
): { from?: string; to?: string } {
  if (selection.range === "7d" || selection.range === "30d") {
    const days = selection.range === "7d" ? 7 : 30;
    const startOfDay = Math.floor(nowMs / DAY_MS) * DAY_MS;
    return { from: new Date(startOfDay - (days - 1) * DAY_MS).toISOString() };
  }
  if (selection.range === "custom") {
    return {
      from: selection.customFrom ? `${selection.customFrom}T00:00:00.000Z` : undefined,
      to: selection.customTo ? `${selection.customTo}T23:59:59.999Z` : undefined,
    };
  }
  return {};
}

export type ContributionMetricKey =
  | "doneIssues" | "mergedIssues" | "workspaces" | "sessions" | "failedSessions" | "abortedSessions"
  | "mergedCommits" | "linesAdded" | "linesRemoved" | "inputTokens" | "outputTokens" | "costUsd" | "activeMs";

export interface ContributionMetric {
  key: ContributionMetricKey;
  label: string;
  kind: "count" | "usd" | "duration";
}

export const CONTRIBUTION_METRICS: readonly ContributionMetric[] = [
  { key: "doneIssues", label: "Done issues", kind: "count" },
  { key: "mergedIssues", label: "Merged issues", kind: "count" },
  { key: "workspaces", label: "Workspaces", kind: "count" },
  { key: "sessions", label: "Sessions", kind: "count" },
  { key: "failedSessions", label: "Failed", kind: "count" },
  { key: "abortedSessions", label: "Aborted", kind: "count" },
  { key: "mergedCommits", label: "Commits", kind: "count" },
  { key: "linesAdded", label: "Lines +", kind: "count" },
  { key: "linesRemoved", label: "Lines −", kind: "count" },
  { key: "inputTokens", label: "Input tokens", kind: "count" },
  { key: "outputTokens", label: "Output tokens", kind: "count" },
  { key: "costUsd", label: "Cost", kind: "usd" },
  { key: "activeMs", label: "Active time", kind: "duration" },
];

export const DEFAULT_CHART_METRIC: ContributionMetricKey = "mergedIssues";

/** "–" for a metric nobody recorded — never 0. */
export function formatMetric(value: number | null, kind: ContributionMetric["kind"]): string {
  if (value === null || value === undefined) return "–";
  if (kind === "usd") return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (kind === "duration") return formatDuration(value);
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return `${Math.round(ms / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

export interface ContributionSort {
  key: "actor" | ContributionMetricKey;
  dir: "asc" | "desc";
}

/** Sort rows; a missing (null) metric always sorts last, whichever the direction. */
export function sortContributionRows(
  rows: readonly ContributionActorRow[],
  sort: ContributionSort,
): ContributionActorRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "actor") return sign * a.actor.localeCompare(b.actor);
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === null && bv === null) return a.actor.localeCompare(b.actor);
    if (av === null) return 1;
    if (bv === null) return -1;
    return av === bv ? a.actor.localeCompare(b.actor) : sign * (av - bv);
  });
}

/** Bar width in percent (0–100) for one value against the largest in the chart. */
export function barPercent(value: number | null, max: number): number {
  if (value === null || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
