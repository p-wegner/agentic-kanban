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
  | "graph"
  | "table"
  | "agents"
  | "timeline"
  | "metrics"
  | "butler"
  | "workflows"
  | "insights"
  | "swimlane"
  | "flaky-tests"
  | "digest"
  | "focus";

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
  digest: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
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
    id: "digest",
    toolbarLabel: "Digest",
    label: "Standup Digest",
    tooltip: "Standup Digest — what changed since you were away",
    icon: ICON.digest,
    paletteIcon: "◷",
    paletteDescription: "What changed since you were away",
    shortcut: "d",
    group: "secondary",
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
    group: "secondary",
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
