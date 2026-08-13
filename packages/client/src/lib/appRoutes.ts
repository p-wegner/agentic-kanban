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

/* ------------------------------------------------------------------ *
 * Project-scoped routes (#446)
 *
 *   /p/<slugOrId>                        -> project, default view (kanban)
 *   /p/<slugOrId>/<viewPath>             -> that view
 *   /p/<slugOrId>/<viewPath>/issue/<n>   -> that view + issue #n's panel
 *   /p/<slugOrId>/issues/<n>             -> short alias: kanban + issue #n
 *
 * Legacy flat paths ("/board", "/burndown", "/", every alias) keep resolving
 * exactly as before, with `projectSlug: null`.
 * ------------------------------------------------------------------ */

/** The project scope prefix used by project-scoped URLs. */
export const PROJECT_ROUTE_PREFIX = "p";

/** The inbound-only short alias segment (`/p/<slug>/issues/<n>`). */
const ISSUE_ALIAS_SEGMENT = "issues";

/** The canonical issue segment emitted by `buildAppPath`. */
const ISSUE_SEGMENT = "issue";

/** The view a project-scoped path with no view segment resolves to. */
const DEFAULT_VIEW: ViewMode = "kanban";

export interface ParsedAppRoute {
  /** Project slug or raw id from `/p/<slugOrId>/…`; null for legacy flat paths. */
  projectSlug: string | null;
  /** Resolved view, or null when the path is not an app route at all. */
  view: ViewMode | null;
  /** Tab to preselect for a legacy absorbed-view route, else null. */
  tab: string | null;
  /** Issue number whose detail panel should open, else null. */
  issueNumber: number | null;
}

const NO_ROUTE: ParsedAppRoute = {
  projectSlug: null,
  view: null,
  tab: null,
  issueNumber: null,
};

function parseIssueNumber(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Resolve the view (and legacy tab) for a single path segment such as "board"
 * or "burndown". Returns null for anything that is not a known view route.
 */
function resolveViewSegment(segment: string): { view: ViewMode; tab: string | null } | null {
  const path = `/${segment}`;
  const view = ROUTE_TO_VIEW[path];
  if (!view) return null;
  return { view, tab: LEGACY_TAB_ROUTES[path]?.tab ?? null };
}

/**
 * Parse any in-app path into its project scope, view, legacy tab and issue
 * deep link. Never throws — malformed input yields null fields.
 */
export function parseAppPath(pathname: string): ParsedAppRoute {
  const normalized = normalizePath(pathname ?? "");
  const segments = normalized.split("/").filter((s) => s.length > 0);

  if (segments[0] !== PROJECT_ROUTE_PREFIX) {
    return parseFlatPath(normalized);
  }

  const projectSlug = segments[1] ? decodeSegment(segments[1]) : null;
  if (!projectSlug) return NO_ROUTE;

  const rest = segments.slice(2);
  const base: ParsedAppRoute = { projectSlug, view: null, tab: null, issueNumber: null };

  // /p/<slug>
  if (rest.length === 0) {
    return { ...base, view: DEFAULT_VIEW };
  }

  // /p/<slug>/issues/<n>
  if (rest[0] === ISSUE_ALIAS_SEGMENT) {
    const issueNumber = parseIssueNumber(rest[1]);
    if (issueNumber === null || rest.length > 2) return base;
    return { ...base, view: DEFAULT_VIEW, issueNumber };
  }

  const resolved = resolveViewSegment(rest[0]);
  if (!resolved) return base;

  // /p/<slug>/<viewPath>
  if (rest.length === 1) {
    return { ...base, view: resolved.view, tab: resolved.tab };
  }

  // /p/<slug>/<viewPath>/issue/<n>
  if (rest[1] !== ISSUE_SEGMENT || rest.length > 3) return base;
  const issueNumber = parseIssueNumber(rest[2]);
  if (issueNumber === null) return base;
  return { ...base, view: resolved.view, tab: resolved.tab, issueNumber };
}

/** Legacy flat paths: no project scope, but issue deep links still parse. */
function parseFlatPath(normalized: string): ParsedAppRoute {
  const view = ROUTE_TO_VIEW[normalized];
  if (view) {
    return {
      projectSlug: null,
      view,
      tab: LEGACY_TAB_ROUTES[normalized]?.tab ?? null,
      issueNumber: null,
    };
  }

  const segments = normalized.split("/").filter((s) => s.length > 0);

  // /issues/<n>
  if (segments[0] === ISSUE_ALIAS_SEGMENT && segments.length === 2) {
    const issueNumber = parseIssueNumber(segments[1]);
    if (issueNumber === null) return NO_ROUTE;
    return { projectSlug: null, view: DEFAULT_VIEW, tab: null, issueNumber };
  }

  // /<viewPath>/issue/<n>
  if (segments.length === 3 && segments[1] === ISSUE_SEGMENT) {
    const resolved = resolveViewSegment(segments[0]);
    const issueNumber = parseIssueNumber(segments[2]);
    if (!resolved || issueNumber === null) return NO_ROUTE;
    return {
      projectSlug: null,
      view: resolved.view,
      tab: resolved.tab,
      issueNumber,
    };
  }

  return NO_ROUTE;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Build an in-app path. Without a project slug this is exactly today's flat
 * path, so nothing regresses before the project list has loaded.
 *
 * Only ever emits the canonical `/issue/<n>` form — `/issues/<n>` is an
 * inbound alias.
 */
export function buildAppPath(opts: {
  projectSlug?: string | null;
  view: ViewMode;
  issueNumber?: number | null;
}): string {
  const viewPath = VIEW_ROUTE_PATHS[opts.view] ?? VIEW_ROUTE_PATHS[DEFAULT_VIEW];
  const slug = opts.projectSlug ? encodeURIComponent(opts.projectSlug) : null;
  const base = slug ? `/${PROJECT_ROUTE_PREFIX}/${slug}${viewPath}` : viewPath;
  const issueNumber =
    typeof opts.issueNumber === "number" && Number.isSafeInteger(opts.issueNumber) && opts.issueNumber > 0
      ? opts.issueNumber
      : null;
  return issueNumber === null ? base : `${base}/${ISSUE_SEGMENT}/${issueNumber}`;
}
