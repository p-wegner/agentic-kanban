import { VIEW_IDS, type ViewMode } from "./viewRegistry.js";
import { resolveViewTab, viewHasTabs } from "./viewTabs.js";

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
 *   /p/<slugOrId>/<viewPath>/<tab>       -> tabbed container view at that tab
 *   /p/<slugOrId>/<viewPath>[/<tab>]/issue/<n>
 *                                        -> that view + issue #n's DETAIL panel
 *   /p/<slugOrId>/<viewPath>[/<tab>]/issue/<n>/workspace
 *                                        -> that view + issue #n's WORKSPACE panel
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

/**
 * Distinguishes the SECOND issue-bearing panel (#446 follow-up). Two different
 * full-height panels can be open on one issue — the detail panel and the
 * workspace/diff drawer — and a URL that named only the issue number reopened
 * the wrong one on reload. The trailing segment names which.
 */
const WORKSPACE_PANEL_SEGMENT = "workspace";

/** Which issue-bearing panel a route opens. */
export type IssuePanel = "issue" | "workspace";

/** The view a project-scoped path with no view segment resolves to. */
const DEFAULT_VIEW: ViewMode = "kanban";

export interface ParsedAppRoute {
  /** Project slug or raw id from `/p/<slugOrId>/…`; null for legacy flat paths. */
  projectSlug: string | null;
  /** Resolved view, or null when the path is not an app route at all. */
  view: ViewMode | null;
  /**
   * Tab to select inside a tabbed container view (#446). Resolved, not raw:
   * a container view always reports a tab (its default when the path names
   * none, or names one that does not exist), and a plain view always null.
   */
  tab: string | null;
  /**
   * Whether the PATH actually named that tab (a tab segment, or a legacy
   * absorbed-view path like `/burndown`) rather than it being the registry
   * default. Because `tab` is resolved, a defaulted tab is indistinguishable
   * from a chosen one — and a caller weighing the path against another source
   * (the legacy `?tab=` param) must not let a default outrank an explicit ask.
   */
  tabIsExplicit: boolean;
  /** Issue number whose panel should open, else null. */
  issueNumber: number | null;
  /** WHICH panel that issue opens — detail or workspace. Null when no issue. */
  panel: IssuePanel | null;
}

const NO_ROUTE: ParsedAppRoute = {
  projectSlug: null,
  view: null,
  tab: null,
  tabIsExplicit: false,
  issueNumber: null,
  panel: null,
};

function parseIssueNumber(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The panel a trailing segment after `/issue/<n>` names. Absent = the detail
 * panel; anything unknown is malformed (null) rather than silently the detail
 * panel, so a typo does not open a different panel than the URL claims.
 */
function parsePanelSegment(raw: string | undefined): IssuePanel | null {
  if (raw === undefined) return "issue";
  return raw === WORKSPACE_PANEL_SEGMENT ? "workspace" : null;
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
 * The part of a path AFTER the view segment: an optional tab segment followed
 * by an optional issue deep link. Shared by the scoped and flat grammars so the
 * two cannot drift.
 *
 * Returns null when the tail is malformed — a tab segment on a view that has no
 * tabs, a junk segment where `issue` was expected, a bad issue number, or an
 * unknown panel segment. `legacyTab` is the tab implied by an absorbed view's
 * old path (`/burndown`); an explicit tab segment wins over it.
 */
function parseViewTail(
  view: ViewMode,
  legacyTab: string | null,
  tail: string[],
): {
  view: ViewMode;
  tab: string | null;
  tabIsExplicit: boolean;
  issueNumber: number | null;
  panel: IssuePanel | null;
} | null {
  const hasTabSegment = tail.length > 0 && tail[0] !== ISSUE_SEGMENT;
  // A plain view has no tab dimension, so an extra segment is not a tab — it is
  // junk, and the path is not a route (same as before #446).
  if (hasTabSegment && !viewHasTabs(view)) return null;
  const named = hasTabSegment ? tail[0] : legacyTab;
  const tab = resolveViewTab(view, named);
  // A tab the path NAMED but that does not exist has been downgraded to the
  // default, so it is not an explicit choice either — it must not outrank a
  // `?tab=` that names a real one.
  const tabIsExplicit = tab !== null && tab === named;
  const issueTail = hasTabSegment ? tail.slice(1) : tail;

  if (issueTail.length === 0) return { view, tab, tabIsExplicit, issueNumber: null, panel: null };
  if (issueTail[0] !== ISSUE_SEGMENT || issueTail.length > 3) return null;
  const issueNumber = parseIssueNumber(issueTail[1]);
  if (issueNumber === null) return null;
  const panel = parsePanelSegment(issueTail[2]);
  if (panel === null) return null;
  return { view, tab, tabIsExplicit, issueNumber, panel };
}

/**
 * Parse any in-app path into its project scope, view, tab and issue deep link.
 * Never throws — malformed input yields null fields.
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
  const base: ParsedAppRoute = {
    projectSlug,
    view: null,
    tab: null,
    tabIsExplicit: false,
    issueNumber: null,
    panel: null,
  };

  // /p/<slug>
  if (rest.length === 0) {
    return { ...base, view: DEFAULT_VIEW };
  }

  // /p/<slug>/issues/<n>
  if (rest[0] === ISSUE_ALIAS_SEGMENT) {
    const issueNumber = parseIssueNumber(rest[1]);
    if (issueNumber === null || rest.length > 2) return base;
    return { ...base, view: DEFAULT_VIEW, issueNumber, panel: "issue" };
  }

  const resolved = resolveViewSegment(rest[0]);
  if (!resolved) return base;

  // /p/<slug>/<viewPath>[/<tab>][/issue/<n>[/workspace]]
  const tail = parseViewTail(resolved.view, resolved.tab, rest.slice(1));
  if (!tail) return base;
  return { ...base, ...tail };
}

/** Legacy flat paths: no project scope, but tab and issue deep links still parse. */
function parseFlatPath(normalized: string): ParsedAppRoute {
  const segments = normalized.split("/").filter((s) => s.length > 0);

  // Whole-path aliases ("/", "/merge-queue", …) and the plain view paths.
  const whole = ROUTE_TO_VIEW[normalized];
  if (whole && segments.length <= 1) {
    const legacyTab = LEGACY_TAB_ROUTES[normalized]?.tab ?? null;
    const tab = resolveViewTab(whole, legacyTab);
    return {
      projectSlug: null,
      view: whole,
      tab,
      tabIsExplicit: tab !== null && tab === legacyTab,
      issueNumber: null,
      panel: null,
    };
  }

  // /issues/<n>
  if (segments[0] === ISSUE_ALIAS_SEGMENT && segments.length === 2) {
    const issueNumber = parseIssueNumber(segments[1]);
    if (issueNumber === null) return NO_ROUTE;
    return {
      projectSlug: null,
      view: DEFAULT_VIEW,
      tab: null,
      tabIsExplicit: false,
      issueNumber,
      panel: "issue",
    };
  }

  // /<viewPath>[/<tab>][/issue/<n>[/workspace]]
  const resolved = segments[0] ? resolveViewSegment(segments[0]) : null;
  if (!resolved) return NO_ROUTE;
  const tail = parseViewTail(resolved.view, resolved.tab, segments.slice(1));
  if (!tail) return NO_ROUTE;
  return { projectSlug: null, ...tail };
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
 * inbound alias. `panel: "workspace"` adds the trailing `/workspace` segment so
 * the workspace drawer reloads as the workspace drawer.
 *
 * `tab` is emitted only when it is given AND the view actually has tabs, so a
 * plain view never grows a phantom segment; an unknown tab downgrades to the
 * view's default rather than putting junk in the address bar.
 */
export function buildAppPath(opts: {
  projectSlug?: string | null;
  view: ViewMode;
  tab?: string | null;
  issueNumber?: number | null;
  panel?: IssuePanel | null;
}): string {
  const viewPath = VIEW_ROUTE_PATHS[opts.view] ?? VIEW_ROUTE_PATHS[DEFAULT_VIEW];
  const tab = opts.tab ? resolveViewTab(opts.view, opts.tab) : null;
  const tabPath = tab ? `/${tab}` : "";
  const slug = opts.projectSlug ? encodeURIComponent(opts.projectSlug) : null;
  const base = slug ? `/${PROJECT_ROUTE_PREFIX}/${slug}${viewPath}${tabPath}` : `${viewPath}${tabPath}`;
  const issueNumber =
    typeof opts.issueNumber === "number" && Number.isSafeInteger(opts.issueNumber) && opts.issueNumber > 0
      ? opts.issueNumber
      : null;
  if (issueNumber === null) return base;
  const issuePath = `${base}/${ISSUE_SEGMENT}/${issueNumber}`;
  return opts.panel === "workspace" ? `${issuePath}/${WORKSPACE_PANEL_SEGMENT}` : issuePath;
}
