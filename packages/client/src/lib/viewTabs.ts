/**
 * Tab metadata for the tabbed container views (#234 Analytics, #235 event feeds).
 *
 * Pure data — consumed by the container components (tab bars), the command
 * palette (one "open at tab" action per tab, so every absorbed view stays one
 * palette hit away), and the legacy route aliases in appRoutes.ts. Lives in
 * lib/ because it imports no components.
 */

export interface ViewTabDescriptor {
  /** Stable tab id — also the `?tab=` query-param value for deep links. */
  id: string;
  /** Short label on the tab button. */
  label: string;
  /** Full name used by the command palette (matches the absorbed view's old label). */
  paletteLabel: string;
  /** Optional visual group header rendered before this tab in the tab bar. */
  group?: string;
  /** Single-glyph icon for the command palette. */
  paletteIcon: string;
  /** Command-palette description line. */
  paletteDescription: string;
}

// ---------------------------------------------------------------------------
// #234 — Analytics: the 7 absorbed single-chart views (calendar stayed a view).
// ---------------------------------------------------------------------------

export const ANALYTICS_VIEW_ID = "analytics";

export const ANALYTICS_TABS: readonly ViewTabDescriptor[] = [
  {
    id: "throughput",
    label: "Throughput",
    paletteLabel: "Throughput",
    group: "Flow",
    paletteIcon: "▦",
    paletteDescription: "Bar chart of issues moved to Done per day over the trailing window",
  },
  {
    id: "lead-time",
    label: "Lead Time",
    paletteLabel: "Lead Time Trend",
    group: "Flow",
    paletteIcon: "LT",
    paletteDescription: "Trend chart of issue lead time (creation → Done) with median and p90 lines",
  },
  {
    id: "burndown",
    label: "Burndown",
    paletteLabel: "Burndown",
    group: "Flow",
    paletteIcon: "BD",
    paletteDescription: "Burndown chart of remaining open issues per day with an ideal target trend line",
  },
  {
    id: "provider-mix",
    label: "Provider Mix",
    paletteLabel: "Provider Mix",
    group: "Agents",
    paletteIcon: "PM",
    paletteDescription: "Stacked bar chart of workspaces grouped by agent provider (claude/codex/copilot)",
  },
  {
    id: "provider-cost",
    label: "Cost",
    paletteLabel: "Provider Cost Over Time",
    group: "Agents",
    paletteIcon: "$",
    paletteDescription: "Stacked bar chart of estimated token cost per day grouped by agent provider",
  },
  {
    id: "agent-throughput",
    label: "Leaderboard",
    paletteLabel: "Agent Throughput Leaderboard",
    group: "Agents",
    paletteIcon: "AT",
    paletteDescription: "Rank agent providers by issues merged, with median lead time",
  },
  {
    id: "scorecard-distribution",
    label: "Scores",
    paletteLabel: "Score Distribution",
    group: "Agents",
    paletteIcon: "SD",
    paletteDescription: "Histogram of workspace scorecard scores across recent workspaces",
  },
];

export type AnalyticsTabId =
  | "throughput"
  | "lead-time"
  | "burndown"
  | "provider-mix"
  | "provider-cost"
  | "agent-throughput"
  | "scorecard-distribution";

export const ANALYTICS_TAB_IDS = ANALYTICS_TABS.map((t) => t.id as AnalyticsTabId);

// ---------------------------------------------------------------------------
// #235 — the two surviving event feeds. Board feed ("activity"): what happened
// to the board. Runtime feed ("runtime"): what the machinery (agents/monitor)
// is doing. Decision + rationale: docs/view-inventory-and-plugin-extraction.md.
// ---------------------------------------------------------------------------

export const ACTIVITY_VIEW_ID = "activity";

export const ACTIVITY_TABS: readonly ViewTabDescriptor[] = [
  {
    id: "activity",
    label: "Activity",
    paletteLabel: "Activity Feed",
    paletteIcon: "⏱",
    paletteDescription: "Project-wide activity: status transitions, merges, sessions in reverse-chronological order",
  },
  {
    id: "digest",
    label: "Digest",
    paletteLabel: "Standup Digest",
    paletteIcon: "◷",
    paletteDescription: "What changed since you were away",
  },
  {
    // Only offered on multi-repo projects — BoardFeedView gates this tab (and
    // useBoardKeyboardShortcuts its palette action) on useProjectRepos.isMultiRepo.
    id: "cross-repo",
    label: "Cross-Repo",
    paletteLabel: "Cross-Repo Activity",
    paletteIcon: "CR",
    paletteDescription: "Live, repo-labeled timeline of what is landing across a multi-repo project (merges, commits, conflicts)",
  },
];

export type ActivityTabId = "activity" | "digest" | "cross-repo";

export const ACTIVITY_TAB_IDS = ACTIVITY_TABS.map((t) => t.id as ActivityTabId);

export const RUNTIME_VIEW_ID = "runtime";

export const RUNTIME_TABS: readonly ViewTabDescriptor[] = [
  {
    id: "flight-recorder",
    label: "Flight Recorder",
    paletteLabel: "Agent Flight Recorder",
    paletteIcon: "FR",
    paletteDescription: "Unified live runtime-event stream across the fleet — filter by workspace, repo, or severity; jump to any transcript",
  },
  {
    id: "monitor-cycles",
    label: "Monitor Cycles",
    paletteLabel: "Monitor Cycle History",
    paletteIcon: "⏱",
    paletteDescription: "Show recent monitor cycle events with action drill-downs",
  },
  {
    id: "health-events",
    label: "Health Events",
    paletteLabel: "Board Health Events",
    paletteIcon: "🔔",
    paletteDescription: "Notification center for monitor health events with category filters",
  },
];

export type RuntimeTabId = "flight-recorder" | "monitor-cycles" | "health-events";

export const RUNTIME_TAB_IDS = RUNTIME_TABS.map((t) => t.id as RuntimeTabId);

// ---------------------------------------------------------------------------
// #446 — the tab as a URL dimension.
//
// The router needs to answer "does this view have tabs, which ones, and what is
// its default?" for EVERY view, and the containers need the same three facts.
// One registry answers both, so a tab added below is routable and palette-
// reachable without touching appRoutes.ts — a second list there would drift.
// ---------------------------------------------------------------------------

/**
 * Path segments the project-scoped URL grammar owns
 * (`/p/<slug>/<view>/<tab>/issue/<n>/workspace`). A tab id colliding with one
 * of these could not be told apart from the issue deep link, so such a tab is
 * simply not routable — it still works in-app, it just never reaches the URL.
 */
export const RESERVED_ROUTE_SEGMENTS: readonly string[] = ["issue", "issues", "workspace"];

export interface ViewTabSet {
  /** The tabs, in bar order. */
  tabs: readonly ViewTabDescriptor[];
  /** The tab shown when the URL names none, or names one that does not exist. */
  defaultTab: string;
}

/** Every tabbed container view, keyed by its view id (which IS its ViewMode). */
export const VIEW_TAB_REGISTRY: Readonly<Record<string, ViewTabSet>> = {
  [ANALYTICS_VIEW_ID]: { tabs: ANALYTICS_TABS, defaultTab: "throughput" },
  [ACTIVITY_VIEW_ID]: { tabs: ACTIVITY_TABS, defaultTab: "activity" },
  [RUNTIME_VIEW_ID]: { tabs: RUNTIME_TABS, defaultTab: "flight-recorder" },
};

/** True when `viewId` is a tabbed container view. Plain views have no tab dimension. */
export function viewHasTabs(viewId: string): boolean {
  return viewId in VIEW_TAB_REGISTRY;
}

/** The tab ids of a container view, in bar order; empty for a plain view. */
export function getViewTabIds(viewId: string): readonly string[] {
  return VIEW_TAB_REGISTRY[viewId]?.tabs.map((t) => t.id) ?? [];
}

/** The tab a container view falls back to; null for a plain view. */
export function getDefaultViewTab(viewId: string): string | null {
  return VIEW_TAB_REGISTRY[viewId]?.defaultTab ?? null;
}

/** True when `tab` exists on `viewId` AND may appear as a URL segment. */
export function isRoutableViewTab(viewId: string, tab: string | null | undefined): boolean {
  if (!tab || RESERVED_ROUTE_SEGMENTS.includes(tab)) return false;
  return getViewTabIds(viewId).includes(tab);
}

/**
 * The tab a view should actually show for a candidate id.
 *
 * - plain view -> null (never invent a tab)
 * - known, routable tab -> itself
 * - unknown / reserved / absent -> the view's default (never a blank screen)
 * - a default that is itself reserved -> null (unroutable, so unnameable)
 */
export function resolveViewTab(viewId: string, candidate: string | null | undefined): string | null {
  if (!viewHasTabs(viewId)) return null;
  if (isRoutableViewTab(viewId, candidate)) return candidate as string;
  const fallback = getDefaultViewTab(viewId);
  return isRoutableViewTab(viewId, fallback) ? fallback : null;
}
