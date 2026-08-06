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
