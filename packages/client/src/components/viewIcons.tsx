import type { ReactNode } from "react";
import { Icon } from "./Icon.js";
import type { ViewMode } from "../lib/viewRegistry.js";

/**
 * The board-view toolbar glyphs, one per `ViewMode` (#829).
 *
 * ## Why this table is not in `lib/viewRegistry.tsx` with the rest of the registry
 *
 * It used to be: `ViewDescriptor` carried an `icon: ReactNode` and the registry hand-wrote 27
 * heroicons `<svg>` wrappers inline. That made `lib/` render JSX, which is a layering
 * violation independent of icons — `lib/` is the layer that is supposed to be pure logic,
 * testable without rendering anything — and it also made the icons unconvertible: adopting
 * `components/Icon.tsx` needs an import from `lib/` UP into `components/`, which
 * `client-upward-type-edge-ratchet.test.ts` (#694) refuses, type-only included. #810 tried it
 * and had to revert.
 *
 * Moving the WHOLE registry down into `components/` would not have worked either: `lib/`
 * modules (`appRoutes.ts`, `navigateView.ts`, `inboxNavigation.ts`, `toolbarTabOverflow.ts`)
 * import `ViewMode`/`ViewDescriptor`, so the same upward edge would simply have reappeared
 * from the other side. The split is the fix, and it is the honest one: the registry DATA (ids,
 * labels, routes, ordering, visibility rules) belongs in `lib/`, the PRESENTATION belongs
 * here, and the `id` is the seam between them.
 *
 * Consumers (`BoardToolbar`, `PluginViewsTab`) look a glyph up by view id rather than reading
 * it off the descriptor. `Record<ViewMode, ReactNode>` makes that total: adding a `ViewMode`
 * without a glyph is a type error, which is the same guarantee the old required field gave.
 */
export const VIEW_ICONS: Record<ViewMode, ReactNode> = {
  kanban: (
    <Icon className="w-3.5 h-3.5">
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="14" rx="1" />
      <rect x="17" y="3" width="5" height="10" rx="1" />
    </Icon>
  ),
  backlog: <Icon className="w-3.5 h-3.5" d="M4 6h16M4 10h16M4 14h10M4 18h8" />,
  graph: (
    <Icon className="w-3.5 h-3.5">
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
    </Icon>
  ),
  table: (
    // Square caps, deliberately: full-width rules that round caps would overhang.
    <Icon className="w-3.5 h-3.5">
      <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
    </Icon>
  ),
  agents: (
    <Icon className="w-3.5 h-3.5">
      <circle cx="12" cy="8" r="4" />
      <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  ),
  timeline: (
    <Icon className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 10h12M3 14h8M3 18h5" />
      <circle cx="20" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  ),
  metrics: (
    <Icon
      className="w-3.5 h-3.5"
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
    />
  ),
  "crime-scene": (
    <Icon className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 20h18M5 20V9l4-3 4 3v11M13 20V7l6 3v10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 12h2M7 15h2M15 12h2M15 15h2" />
      <circle cx="18" cy="6" r="2" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // The two-`<path>` glyphs below are one `d` with two subpaths: the pair always carried
  // identical stroke attributes, so concatenating them draws the same marks.
  "quality-metrics": <Icon className="w-3.5 h-3.5" d="M4 19V5m0 14h16M8 16l3-5 3 2 4-7M8 19v-3m6 3v-6m4 6V6" />,
  milestones: <Icon className="w-3.5 h-3.5" d="M4 6h10M4 12h16M4 18h8M16 4v5l4-2.5L16 4z" />,
  strategy: (
    <Icon className="w-3.5 h-3.5">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v2M12 18v2M4 12h2M18 12h2" />
    </Icon>
  ),
  focus: (
    <Icon
      className="w-3.5 h-3.5"
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
    />
  ),
  butler: (
    <Icon
      className="w-3.5 h-3.5"
      d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
    />
  ),
  workflows: <Icon className="w-3.5 h-3.5" d="M3.75 6.75h4.5v4.5h-4.5v-4.5zM15.75 12.75h4.5v4.5h-4.5v-4.5zM8.25 9h4.5m-2.25 0v6.75m0 0h3" />,
  "workflow-analytics": <Icon className="w-3.5 h-3.5" d="M4 19V5m0 14h16M7 15l3-4 3 2 4-7M7 19v-4m6 4v-6m4 6V6" />,
  insights: <Icon className="w-3.5 h-3.5" d="M3 13l4-4 4 4 4-8 4 4" />,
  swimlane: <Icon className="w-3.5 h-3.5" d="M3 6h18M3 12h18M3 18h18" />,
  "flaky-tests": (
    <Icon
      className="w-3.5 h-3.5"
      d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
    />
  ),
  runtime: <Icon className="w-3.5 h-3.5" d="M3 12h3l2 5 4-14 2 9 2-3h5" />,
  runbooks: (
    <Icon
      className="w-3.5 h-3.5"
      d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
    />
  ),
  capacity: <Icon className="w-3.5 h-3.5" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18" />,
  activity: <Icon className="w-3.5 h-3.5" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0zM3 12h2M19 12h2M12 3v2M12 19v2" />,
  "stale-work": <Icon className="w-3.5 h-3.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
  analytics: <Icon className="w-3.5 h-3.5" d="M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18" />,
  calendar: (
    <Icon className="w-3.5 h-3.5">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
    </Icon>
  ),
  drive: <Icon className="w-3.5 h-3.5" d="M13 10V3L4 14h7v7l9-11h-7z" />,
  // Puzzle piece — plugin-provided embedded views.
  "plugin-views": (
    <Icon
      className="w-3.5 h-3.5"
      d="M14 7h3a1 1 0 011 1v3h-1.5a1.5 1.5 0 000 3H18v3a1 1 0 01-1 1h-3v-1.5a1.5 1.5 0 00-3 0V18H8a1 1 0 01-1-1v-3H5.5a1.5 1.5 0 010-3H7V8a1 1 0 011-1h3V5.5a1.5 1.5 0 013 0V7z"
    />
  ),
};

/** The glyph for a view id. */
export function viewIcon(id: ViewMode): ReactNode {
  return VIEW_ICONS[id];
}
