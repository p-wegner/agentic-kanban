/**
 * The canonical board-view registry (ticket #116).
 *
 * This module is the single source of truth for every board view. The toolbar
 * view switcher, the command palette ("Switch to <View> View"), and the `?`
 * keyboard-shortcuts overlay all derive their view lists from `VIEW_REGISTRY`.
 *
 * The toolbar GLYPHS are not here: they are JSX, and `lib/` may not import `components/`
 * (`client-upward-type-edge-ratchet.test.ts`, #694). They live in `components/viewIcons.tsx`
 * keyed by view id (#829); the type is `Record<ViewMode, ReactNode>`, so a new view id is a
 * compile error until it has a glyph. Everything in this file is data, which is why it stays
 * in `lib/` — the `lib/` modules that route and navigate by `ViewMode` would otherwise have
 * had to reach up into `components/` themselves.
 *
 * This file keeps its `.tsx` extension despite holding no JSX: `packages/server/scripts/
 * generate-bundled-skill.mjs` reads it by that exact path to build the bundled skill's view
 * table.
 *
 * To add a new board view, add ONE entry here — it will automatically surface
 * in the toolbar, the command palette, and the shortcuts overlay. Remember to
 * also render the view component in BoardPage's view switch, and add its glyph to
 * `components/viewIcons.tsx`.
 */

export type ViewMode =
  | "kanban"
  | "backlog"
  | "graph"
  | "table"
  | "agents"
  | "timeline"
  | "metrics"
  | "crime-scene"
  | "quality-metrics"
  | "milestones"
  | "butler"
  | "workflows"
  | "workflow-analytics"
  | "insights"
  | "swimlane"
  | "flaky-tests"
  | "runtime"
  | "drive"
  | "strategy"
  | "focus"
  | "runbooks"
  | "capacity"
  | "activity"
  | "stale-work"
  | "analytics"
  | "calendar"
  | "plugin-views";

export interface ViewDescriptor {
  /** Stable view id — matches BoardPage's `viewMode` state. */
  id: ViewMode;
  /** Short label shown on the toolbar button (e.g. "Board", "Flaky"). */
  toolbarLabel: string;
  /** Full label used by the command palette and shortcuts overlay (e.g. "Board", "Swimlane", "Butler chat"). */
  label: string;
  /** Tooltip text for the toolbar button. The shortcut hint (if any) is appended automatically unless `tooltip` already contains it. */
  tooltip: string;
  /** Single-glyph icon used by the command palette. */
  paletteIcon: string;
  /** Command-palette description line. */
  paletteDescription: string;
  /**
   * Single-key shortcut. Optional — `workflows` has none.
   * The shortcut is wired up in BoardPage's keydown handler and shown in the overlay.
   */
  shortcut?: string;
  /**
   * Some views use a non-default active-button color (insights/swimlane = blue,
   * flaky-tests = amber). Defaults to the brand color when omitted.
   */
  activeClass?: string;
  /** `graph` is reached via a `g` chord (g+s opens settings) rather than a plain key handler. */
  chord?: boolean;
  /** `butler` renders a pending-question badge. */
  badge?: "butler";
  /**
   * Toolbar placement (#109). `"primary"` views render as direct tabs; `"secondary"`
   * views are tucked behind the toolbar's "More" overflow dropdown to keep the tab
   * row scannable. Defaults to `"primary"` when omitted. Grouping is purely visual —
   * keyboard shortcuts and the command palette reach every view regardless of group.
   */
  group?: "primary" | "secondary";
}

/**
 * The canonical, ordered list of board views. Order = toolbar render order.
 */
export const VIEW_REGISTRY: ViewDescriptor[] = [
  {
    id: "kanban",
    toolbarLabel: "Board",
    label: "Board",
    tooltip: "Kanban view",
    paletteIcon: "⊟",
    paletteDescription: "Show kanban board columns",
    shortcut: "b",
  },
  {
    id: "calendar",
    toolbarLabel: "Calendar",
    label: "Calendar",
    tooltip: "Calendar - issues by created, updated, or status-change date",
    paletteIcon: "Cal",
    paletteDescription: "Show issues on a monthly calendar by board timestamps",
  },
  {
    id: "backlog",
    toolbarLabel: "Backlog",
    label: "Backlog",
    tooltip: "Dedicated backlog view",
    paletteIcon: "BL",
    paletteDescription: "Plan, sort, group, and triage backlog issues",
    shortcut: "r",
  },
  {
    id: "graph",
    toolbarLabel: "Graph",
    label: "Graph",
    tooltip: "Graph view",
    paletteIcon: "⬡",
    paletteDescription: "Show dependency graph",
    shortcut: "g",
    chord: true,
  },
  {
    id: "table",
    toolbarLabel: "Table",
    label: "Table",
    tooltip: "Table view",
    paletteIcon: "☰",
    paletteDescription: "Show flat table list",
    shortcut: "t",
  },
  {
    id: "agents",
    toolbarLabel: "Agents",
    label: "Agents",
    tooltip: "Agents view",
    paletteIcon: "⚡",
    paletteDescription: "Live grid of all active agent sessions",
    shortcut: "l",
  },
  {
    id: "timeline",
    toolbarLabel: "Timeline",
    label: "Timeline",
    tooltip: "Timeline view",
    paletteIcon: "⏱",
    paletteDescription: "Show issues on a chronological timeline",
    shortcut: "f",
  },
  {
    id: "metrics",
    toolbarLabel: "Metrics",
    label: "Metrics",
    tooltip: "Metrics view",
    paletteIcon: "▥",
    paletteDescription: "Show board metrics and charts",
    shortcut: "m",
    group: "secondary",
  },
  {
    id: "crime-scene",
    toolbarLabel: "Hotspots",
    label: "Code Crime Scene",
    tooltip: "Code Crime Scene - city view of churn hotspots",
    paletteIcon: "CS",
    paletteDescription: "Visualize the codebase as districts and buildings with hotspot evidence markers",
    activeClass: "bg-red-700 text-white",
    group: "secondary",
  },
  {
    id: "quality-metrics",
    toolbarLabel: "Quality",
    label: "Quality Metrics",
    tooltip: "Quality Metrics view",
    paletteIcon: "QM",
    paletteDescription: "Show collected code quality metrics",
    shortcut: "y",
    activeClass: "bg-emerald-600 text-white",
    group: "secondary",
  },
  {
    id: "milestones",
    toolbarLabel: "Milestones",
    label: "Milestones",
    tooltip: "Milestones - progress, counts, and mini-burndown",
    paletteIcon: "MS",
    paletteDescription: "Show per-milestone progress, open counts, and burndown",
    activeClass: "bg-emerald-600 text-white",
    group: "secondary",
  },
  {
    id: "strategy",
    toolbarLabel: "Strategy",
    label: "Strategic Targets",
    tooltip: "Strategic Targets - weighted focus board",
    paletteIcon: "ST",
    paletteDescription: "Map strategic directions onto a target board",
    shortcut: "z",
    activeClass: "bg-brand-600 text-white",
  },
  {
    id: "focus",
    toolbarLabel: "Focus",
    label: "Focus",
    tooltip: "Focus — what should I work on next?",
    paletteIcon: "◎",
    paletteDescription: "What should I work on next?",
    shortcut: "o",
    group: "secondary",
  },
  {
    id: "butler",
    toolbarLabel: "Butler",
    label: "Butler chat",
    tooltip: "Butler chat",
    paletteIcon: "💬",
    paletteDescription: "Chat with the persistent project butler agent",
    shortcut: "i",
    badge: "butler",
  },
  {
    id: "workflows",
    toolbarLabel: "Workflows",
    label: "Workflows",
    tooltip: "Workflows — design ticket-type pipelines",
    paletteIcon: "⛓",
    paletteDescription: "Design ticket-type pipelines",
    shortcut: "u",
  },
  {
    // Primary tab placed after Graph → Butler → Workflows (its toolbar button is a
    // per-plugin dropdown, special-cased in BoardToolbar via PluginViewsTab).
    id: "plugin-views",
    toolbarLabel: "Plugins",
    label: "Plugins",
    tooltip: "Plugins — one view per enabled plugin, plus install & marketplace",
    paletteIcon: "🧩",
    paletteDescription: "Everything this project's enabled plugins offer: embedded views, converging analysis loops, one-shot scripts, and skills launched as tickets",
    activeClass: "bg-violet-600 text-white",
  },
  {
    id: "workflow-analytics",
    toolbarLabel: "Flow Stats",
    label: "Workflow Analytics",
    tooltip: "Workflow Analytics - stage trends and drop-off",
    paletteIcon: "WA",
    paletteDescription: "Show workflow stage trends, funnel drop-off, and burn-down",
    shortcut: "h",
    activeClass: "bg-emerald-600 text-white",
    group: "secondary",
  },
  {
    id: "insights",
    toolbarLabel: "Insights",
    label: "Insights",
    tooltip: "Insights — agent cost, tokens, success rate",
    paletteIcon: "↗",
    paletteDescription: "Show agent cost, token, success, and duration trends",
    shortcut: "n",
    activeClass: "bg-blue-600 text-white",
  },
  {
    id: "swimlane",
    toolbarLabel: "Swimlane",
    label: "Swimlane",
    tooltip: "Swimlane — priority lanes × status columns",
    paletteIcon: "≣",
    paletteDescription: "Priority lanes × status columns",
    shortcut: "p",
    activeClass: "bg-blue-600 text-white",
    group: "secondary",
  },
  {
    id: "flaky-tests",
    toolbarLabel: "Flaky",
    label: "Flaky Tests Radar",
    tooltip: "Flaky Tests Radar — intermittent failures",
    paletteIcon: "⚠",
    paletteDescription: "Track intermittent test failures",
    shortcut: "k",
    activeClass: "bg-amber-500 text-white",
    group: "secondary",
  },
  {
    // Operational event feed (#235): absorbs the former agent-flight-recorder,
    // monitor-history, and health-events views as tabs (RuntimeFeedView). Keeps
    // monitor-history's former primary toolbar slot so one operational feed
    // stays one click away. Each tab is palette-reachable ("Runtime Feed: …")
    // and deep-linkable; legacy routes redirect here (appRoutes.ts).
    id: "runtime",
    toolbarLabel: "Runtime",
    label: "Runtime Feed",
    tooltip: "Runtime Feed — agent flight recorder, monitor cycle history, and board health events",
    paletteIcon: "FR",
    paletteDescription: "Operational feed: live agent runtime events, monitor cycle history, and health notifications as tabs",
    activeClass: "bg-indigo-500 text-white",
  },
  {
    id: "drive",
    toolbarLabel: "Drive",
    label: "Drive Dashboard",
    tooltip: "Drive Dashboard — per-drive progress, tier graph, stalls, and build-clean status",
    paletteIcon: "⚡",
    paletteDescription: "At-a-glance view of a running drive: N/N progress, dependency tiers, stalls, last cascade, build-clean status",
    activeClass: "bg-brand-600 text-white",
  },
  {
    id: "runbooks",
    toolbarLabel: "Runbooks",
    label: "Runbooks",
    tooltip: "Runbooks — project operational docs and learnings",
    paletteIcon: "📖",
    paletteDescription: "Browse project docs: CLAUDE.md, learnings, decisions, board-monitor runbook",
    shortcut: "j",
    group: "secondary",
  },
  {
    id: "capacity",
    toolbarLabel: "Capacity",
    label: "Sprint Capacity Planner",
    tooltip: "Sprint Capacity Planner — agent slots, backlog health, next cycle preview",
    paletteIcon: "⬡",
    paletteDescription: "Show agent capacity, open slots, and next issues to launch",
    // No single-key shortcut: "c" is a reserved global board action (see
    // useBoardKeyboardShortcuts). Reachable via the More menu and Ctrl+K palette.
    group: "secondary",
  },
  // The four decorative views — constellation (`e`), momentum (`v`), fireworks,
  // garden — were extracted to the external `board-whimsy` plugin (#237); momentum
  // was dropped outright (swimlane is a strict superset). The `v` and `e`
  // single-key shortcuts are FREE for future views.
  {
    // Board-side event feed (#235): absorbs the former digest and
    // cross-repo-activity views as tabs (BoardFeedView). The Cross-Repo tab is
    // only offered on multi-repo projects. Digest's former "d" shortcut was
    // freed, not reassigned — digest stays palette-/deep-link-reachable.
    id: "activity",
    toolbarLabel: "Activity",
    label: "Activity Feed",
    tooltip: "Activity Feed — status changes and merges, standup digest, and cross-repo activity as tabs",
    paletteIcon: "⏱",
    paletteDescription: "Board feed: status transitions, merges and sessions, plus standup digest and (multi-repo) cross-repo activity as tabs",
    // No single-key shortcut: "x" is a reserved global board action (see
    // useBoardKeyboardShortcuts). Reachable via the More menu and Ctrl+K palette.
    group: "secondary",
  },
  {
    id: "stale-work",
    toolbarLabel: "Stale",
    label: "Stale Work",
    tooltip: "Stale Work — issues stuck in a column beyond a configurable threshold",
    paletteIcon: "⏰",
    paletteDescription: "List issues stuck in their current column with one-click nudge",
    activeClass: "bg-amber-500 text-white",
    group: "secondary",
  },
  {
    // Tabbed Analytics container (#234): absorbs the former single-chart views
    // throughput, lead-time, burndown (Flow) and provider-mix, provider-cost,
    // agent-throughput, scorecard-distribution (Agents) as tabs. Each chart is
    // still reachable individually via the command palette ("Analytics: …"
    // actions) and via `?tab=` deep links; legacy routes like /burndown
    // redirect here with the right tab preselected (see appRoutes.ts).
    id: "analytics",
    toolbarLabel: "Analytics",
    label: "Analytics",
    tooltip: "Analytics — throughput, lead time, burndown, provider mix, cost, leaderboard, scores",
    paletteIcon: "▦",
    paletteDescription: "Tabbed analytics charts: flow (throughput, lead time, burndown) and agents (provider mix, cost, leaderboard, score distribution)",
    activeClass: "bg-emerald-600 text-white",
    group: "secondary",
  },
];

/** Set of all valid view ids — used for validating persisted `viewMode`. */
export const VIEW_IDS: ViewMode[] = VIEW_REGISTRY.map((v) => v.id);

/** Primary views — rendered as direct toolbar tabs (#109). */
export const PRIMARY_VIEWS: ViewDescriptor[] = VIEW_REGISTRY.filter((v) => v.group !== "secondary");

/** Secondary/analytics views — tucked behind the toolbar "More" overflow dropdown (#109). */
export const SECONDARY_VIEWS: ViewDescriptor[] = VIEW_REGISTRY.filter((v) => v.group === "secondary");

/**
 * Map of single-key shortcut → view id, for views whose shortcut is handled by
 * the plain keydown branch (excludes the `graph` chord, handled separately).
 */
export const SHORTCUT_TO_VIEW: Record<string, ViewMode> = Object.fromEntries(
  VIEW_REGISTRY.filter((v) => v.shortcut && !v.chord).map((v) => [v.shortcut as string, v.id]),
);

// ── Per-project view visibility (#233) ───────────────────────────────────────

/**
 * The one view that can never be hidden.
 *
 * Guarded HERE rather than only in the picker UI, because the pref is writable by the CLI, MCP
 * and any other client: a board whose only remaining view is hidden has no way back.
 */
export const UNHIDEABLE_VIEWS: ViewMode[] = ["kanban"];

/**
 * Parse a `hidden_views_<projectId>` preference value into a set of view ids.
 *
 * Tolerant by design and silent about junk: this value is per-project configuration, and a
 * malformed one must degrade to "hide nothing" rather than blank the toolbar. Unknown ids are
 * dropped rather than kept — a view removed from the registry in a later release would otherwise
 * sit in the pref forever, and keeping it would make `hiddenCount` lie.
 */
export function parseHiddenViews(raw: string | null | undefined): Set<ViewMode> {
  if (!raw) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const valid = new Set<string>(VIEW_IDS);
  return new Set(
    parsed.filter((id): id is ViewMode =>
      typeof id === "string" && valid.has(id) && !UNHIDEABLE_VIEWS.includes(id as ViewMode)),
  );
}

/** Serialize a hidden-view selection, dropping anything that may not be hidden. */
export function serializeHiddenViews(hidden: Iterable<ViewMode>): string {
  const kept = [...new Set(hidden)].filter((id) => !UNHIDEABLE_VIEWS.includes(id));
  // Registry order, so the stored value is stable regardless of click order and two equivalent
  // selections produce the same string (which keeps a no-op save from looking like a change).
  kept.sort((a, b) => VIEW_IDS.indexOf(a) - VIEW_IDS.indexOf(b));
  return JSON.stringify(kept);
}

/**
 * The registry minus the hidden set, in the shapes the five consumers need.
 *
 * All five (toolbar primary tabs, "More" overflow, command palette, shortcut overlay, shortcut
 * key map) already derived from `VIEW_REGISTRY`; this filters ONCE and hands each the same
 * answer, rather than adding a second source of truth per consumer.
 */
export function visibleViews(hidden: Set<ViewMode>): {
  all: ViewDescriptor[];
  primary: ViewDescriptor[];
  secondary: ViewDescriptor[];
  shortcutToView: Record<string, ViewMode>;
} {
  const all = VIEW_REGISTRY.filter((v) => !hidden.has(v.id));
  return {
    all,
    primary: all.filter((v) => v.group !== "secondary"),
    secondary: all.filter((v) => v.group === "secondary"),
    shortcutToView: Object.fromEntries(
      all.filter((v) => v.shortcut && !v.chord).map((v) => [v.shortcut as string, v.id]),
    ),
  };
}

/**
 * The view to actually render, given what the user last had open.
 *
 * A hidden view that is still the persisted `viewMode` must fall back rather than render a panel
 * the user can no longer navigate back to — the toolbar would show no active tab and the only
 * escape would be a URL edit.
 */
export function resolveVisibleView(viewMode: ViewMode, hidden: Set<ViewMode>): ViewMode {
  return hidden.has(viewMode) ? "kanban" : viewMode;
}
