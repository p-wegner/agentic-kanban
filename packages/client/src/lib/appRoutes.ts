import { VIEW_IDS, type ViewMode } from "./viewRegistry.js";

const VIEW_ROUTE_PATHS: Record<ViewMode, string> = {
  kanban: "/board",
  backlog: "/backlog",
  graph: "/graph",
  table: "/table",
  agents: "/agents",
  timeline: "/timeline",
  metrics: "/metrics",
  "quality-metrics": "/quality-metrics",
  butler: "/butler",
  workflows: "/workflows",
  "workflow-analytics": "/workflow-analytics",
  insights: "/insights",
  swimlane: "/swimlane",
  "flaky-tests": "/flaky-tests",
  "monitor-history": "/monitor-history",
  digest: "/digest",
  strategy: "/strategy",
  focus: "/focus",
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

const ROUTE_TO_VIEW: Record<string, ViewMode> = {
  ...ROUTE_ALIASES,
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
