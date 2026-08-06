import { VIEW_IDS, type ViewMode } from "./viewRegistry.js";

const VIEW_ROUTE_PATHS: Record<ViewMode, string> = {
  kanban: "/board",
  backlog: "/backlog",
  graph: "/graph",
  table: "/table",
  agents: "/agents",
  timeline: "/timeline",
  metrics: "/metrics",
  "crime-scene": "/crime-scene",
  "quality-metrics": "/quality-metrics",
  milestones: "/milestones",
  butler: "/butler",
  workflows: "/workflows",
  "workflow-analytics": "/workflow-analytics",
  insights: "/insights",
  swimlane: "/swimlane",
  "flaky-tests": "/flaky-tests",
  runtime: "/runtime",
  drive: "/drive",
  strategy: "/strategy",
  focus: "/focus",
  runbooks: "/runbooks",
  capacity: "/capacity",
  activity: "/activity",
  "stale-work": "/stale-work",
  analytics: "/analytics",
  calendar: "/calendar",
  "plugin-views": "/plugin-views",
};

const ROUTE_ALIASES: Record<string, ViewMode> = {
  "/": "kanban",
  "/board": "kanban",
  "/kanban": "kanban",
  "/workspace": "agents",
  "/workspaces": "agents",
  "/all-workspaces": "agents",
  "/queue": "agents",
  "/merge-queue": "agents",
};

/**
 * Legacy routes of views absorbed into tabbed containers (#234/#235): the old
 * path keeps working as a deep link — it resolves to the container view AND
 * names the tab to preselect (useBoardPageRoute forwards it to viewTabStore).
 */
const LEGACY_TAB_ROUTES: Record<string, { view: ViewMode; tab: string }> = {
  "/throughput": { view: "analytics", tab: "throughput" },
  "/lead-time": { view: "analytics", tab: "lead-time" },
  "/burndown": { view: "analytics", tab: "burndown" },
  "/provider-mix": { view: "analytics", tab: "provider-mix" },
  "/provider-cost": { view: "analytics", tab: "provider-cost" },
  "/agent-throughput": { view: "analytics", tab: "agent-throughput" },
  "/scorecard-distribution": { view: "analytics", tab: "scorecard-distribution" },
  "/digest": { view: "activity", tab: "digest" },
  "/cross-repo-activity": { view: "activity", tab: "cross-repo" },
  "/agent-flight-recorder": { view: "runtime", tab: "flight-recorder" },
  "/monitor-history": { view: "runtime", tab: "monitor-cycles" },
  "/health-events": { view: "runtime", tab: "health-events" },
};

const ROUTE_TO_VIEW: Record<string, ViewMode> = {
  ...ROUTE_ALIASES,
  ...Object.fromEntries(
    Object.entries(LEGACY_TAB_ROUTES).map(([path, target]) => [path, target.view]),
  ),
  ...Object.fromEntries(
    VIEW_IDS.map((id) => [VIEW_ROUTE_PATHS[id], id]),
  ),
};

export function getViewRoutePath(viewMode: ViewMode): string {
  return VIEW_ROUTE_PATHS[viewMode];
}

export function getAppRouteView(pathname: string): ViewMode | null {
  const normalized = normalizePath(pathname);
  return ROUTE_TO_VIEW[normalized] ?? null;
}

/**
 * The tab a legacy absorbed-view route should preselect in its container view,
 * or null when the path is not a legacy tab route.
 */
export function getAppRouteTab(pathname: string): { view: ViewMode; tab: string } | null {
  return LEGACY_TAB_ROUTES[normalizePath(pathname)] ?? null;
}

export function isAppRoutePath(pathname: string): boolean {
  return getAppRouteView(pathname) !== null;
}

function normalizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}
