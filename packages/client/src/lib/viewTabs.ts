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
