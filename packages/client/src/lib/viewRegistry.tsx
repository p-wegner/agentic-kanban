import type { ReactNode } from "react";

/**
 * The canonical board-view registry (ticket #116).
 *
 * This module is the single source of truth for every board view. The toolbar
 * view switcher, the command palette ("Switch to <View> View"), and the `?`
 * keyboard-shortcuts overlay all derive their view lists from `VIEW_REGISTRY`.
 *
 * To add a new board view, add ONE entry here — it will automatically surface
 * in the toolbar, the command palette, and the shortcuts overlay. Remember to
 * also render the view component in BoardPage's view switch.
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
  /** SVG icon (toolbar). */
  icon: ReactNode;
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

const ICON = {
  kanban: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="14" rx="1" />
      <rect x="17" y="3" width="5" height="10" rx="1" />
    </svg>
  ),
  backlog: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h10M4 18h8" />
    </svg>
  ),
  graph: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
    </svg>
  ),
  table: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
    </svg>
  ),
  agents: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="8" r="4" />
      <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  timeline: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 10h12M3 14h8M3 18h5" />
      <circle cx="20" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  metrics: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  "crime-scene": (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 20h18M5 20V9l4-3 4 3v11M13 20V7l6 3v10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 12h2M7 15h2M15 12h2M15 15h2" />
      <circle cx="18" cy="6" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  "quality-metrics": (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5m0 14h16M8 16l3-5 3 2 4-7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 19v-3m6 3v-6m4 6V6" />
    </svg>
  ),
  milestones: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h10M4 12h16M4 18h8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v5l4-2.5L16 4z" />
    </svg>
  ),
  strategy: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v2M12 18v2M4 12h2M18 12h2" />
    </svg>
  ),
  focus: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ),
  butler: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  ),
  workflows: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h4.5v4.5h-4.5v-4.5zM15.75 12.75h4.5v4.5h-4.5v-4.5zM8.25 9h4.5m-2.25 0v6.75m0 0h3" />
    </svg>
  ),
  "workflow-analytics": (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5m0 14h16M7 15l3-4 3 2 4-7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 19v-4m6 4v-6m4 6V6" />
    </svg>
  ),
  insights: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l4-4 4 4 4-8 4 4" />
    </svg>
  ),
  swimlane: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  ),
  "flaky-tests": (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  ),
  runtime: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h3l2 5 4-14 2 9 2-3h5" />
    </svg>
  ),
  runbooks: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  ),
  capacity: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 19h18" />
    </svg>
  ),
  activity: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h2M19 12h2M12 3v2M12 19v2" />
    </svg>
  ),
  "stale-work": (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  analytics: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18" />
    </svg>
  ),
  calendar: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  drive: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  ),
  "plugin-views": (
    // Puzzle piece — plugin-provided embedded views.
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 7h3a1 1 0 011 1v3h-1.5a1.5 1.5 0 000 3H18v3a1 1 0 01-1 1h-3v-1.5a1.5 1.5 0 00-3 0V18H8a1 1 0 01-1-1v-3H5.5a1.5 1.5 0 010-3H7V8a1 1 0 011-1h3V5.5a1.5 1.5 0 013 0V7z" />
    </svg>
  ),
} as const;

/**
 * The canonical, ordered list of board views. Order = toolbar render order.
 */
export const VIEW_REGISTRY: ViewDescriptor[] = [
  {
    id: "kanban",
    toolbarLabel: "Board",
    label: "Board",
    tooltip: "Kanban view",
    icon: ICON.kanban,
    paletteIcon: "⊟",
    paletteDescription: "Show kanban board columns",
    shortcut: "b",
  },
  {
    id: "calendar",
    toolbarLabel: "Calendar",
    label: "Calendar",
    tooltip: "Calendar - issues by created, updated, or status-change date",
    icon: ICON.calendar,
    paletteIcon: "Cal",
    paletteDescription: "Show issues on a monthly calendar by board timestamps",
  },
  {
    id: "backlog",
    toolbarLabel: "Backlog",
    label: "Backlog",
    tooltip: "Dedicated backlog view",
    icon: ICON.backlog,
    paletteIcon: "BL",
    paletteDescription: "Plan, sort, group, and triage backlog issues",
    shortcut: "r",
  },
  {
    id: "graph",
    toolbarLabel: "Graph",
    label: "Graph",
    tooltip: "Graph view",
    icon: ICON.graph,
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
    icon: ICON.table,
    paletteIcon: "☰",
    paletteDescription: "Show flat table list",
    shortcut: "t",
  },
  {
    id: "agents",
    toolbarLabel: "Agents",
    label: "Agents",
    tooltip: "Agents view",
    icon: ICON.agents,
    paletteIcon: "⚡",
    paletteDescription: "Live grid of all active agent sessions",
    shortcut: "l",
  },
  {
    id: "timeline",
    toolbarLabel: "Timeline",
    label: "Timeline",
    tooltip: "Timeline view",
    icon: ICON.timeline,
    paletteIcon: "⏱",
    paletteDescription: "Show issues on a chronological timeline",
    shortcut: "f",
  },
  {
    id: "metrics",
    toolbarLabel: "Metrics",
    label: "Metrics",
    tooltip: "Metrics view",
    icon: ICON.metrics,
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
    icon: ICON["crime-scene"],
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
    icon: ICON["quality-metrics"],
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
    icon: ICON.milestones,
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
    icon: ICON.strategy,
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
    icon: ICON.focus,
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
    icon: ICON.butler,
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
    icon: ICON.workflows,
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
    icon: ICON["plugin-views"],
    paletteIcon: "🧩",
    paletteDescription: "Everything this project's enabled plugins offer: embedded views, converging analysis loops, one-shot scripts, and skills launched as tickets",
    activeClass: "bg-violet-600 text-white",
  },
  {
    id: "workflow-analytics",
    toolbarLabel: "Flow Stats",
    label: "Workflow Analytics",
    tooltip: "Workflow Analytics - stage trends and drop-off",
    icon: ICON["workflow-analytics"],
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
    icon: ICON.insights,
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
    icon: ICON.swimlane,
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
    icon: ICON["flaky-tests"],
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
    icon: ICON.runtime,
    paletteIcon: "FR",
    paletteDescription: "Operational feed: live agent runtime events, monitor cycle history, and health notifications as tabs",
    activeClass: "bg-indigo-500 text-white",
  },
  {
    id: "drive",
    toolbarLabel: "Drive",
    label: "Drive Dashboard",
    tooltip: "Drive Dashboard — per-drive progress, tier graph, stalls, and build-clean status",
    icon: ICON.drive,
    paletteIcon: "⚡",
    paletteDescription: "At-a-glance view of a running drive: N/N progress, dependency tiers, stalls, last cascade, build-clean status",
    activeClass: "bg-brand-600 text-white",
  },
  {
    id: "runbooks",
    toolbarLabel: "Runbooks",
    label: "Runbooks",
    tooltip: "Runbooks — project operational docs and learnings",
    icon: ICON.runbooks,
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
    icon: ICON.capacity,
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
    icon: ICON.activity,
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
    icon: ICON["stale-work"],
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
    icon: ICON.analytics,
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
