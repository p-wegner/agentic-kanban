/**
 * Route <-> board-state synchronisation logic (#446), kept PURE so it can be
 * unit-tested without a DOM (the client test env has no jsdom).
 *
 * Two directions, two sets of helpers:
 *
 *  - INBOUND  (`planDeepLinkProject` / `planDeepLinkIssue`): a pasted URL names
 *    a project and possibly an issue. The projects query and the board-columns
 *    query resolve asynchronously and in an unpredictable order, so the parsed
 *    link is held as a `PendingDeepLink` and each planner answers "can I apply
 *    this yet, and what should happen?" — `wait` until the data is there, then
 *    exactly ONE terminal step. Once a step is applied the pending entry is
 *    marked settled and never re-applied, so a refetch or a re-render cannot
 *    reopen a detail panel the user closed.
 *
 *  - OUTBOUND (`planUrlSync`): given the CURRENT (project, view, issue) state,
 *    what should the address bar say, and should that be a push or a replace?
 *    Driving the URL off state (rather than off each navigation call site) is
 *    what makes the CustomEvent deep links — inbox chip, gate toasts, plugin
 *    loop ticket links — produce a pasteable URL for free.
 *
 * `NavigationBurst` solves the "one back-step" problem: a single logical
 * navigation fires project -> view -> issue in sequence, which would otherwise
 * push three history entries. A burst allows the FIRST resulting URL write to
 * push and coalesces the rest into replaces, so the user gets one entry holding
 * the final URL. A "silent" burst (used while restoring from popstate) allows
 * no push at all — the entry already exists.
 */
import { buildAppPath, parseAppPath, type IssuePanel } from "../lib/appRoutes.js";
import { buildProjectSlugMap, resolveProjectIdFromSlug, type SlugProject } from "../lib/projectSlug.js";
import type { ViewMode } from "../lib/viewRegistry.js";
import { getDefaultViewTab, isRoutableViewTab, viewHasTabs } from "../lib/viewTabs.js";

/* ------------------------------------------------------------------ *
 * Inbound: a deep link held until the data it names has loaded
 * ------------------------------------------------------------------ */

export interface PendingDeepLink {
  /** `/p/<slugOrId>` segment from the inbound URL; null when unscoped. */
  projectSlug: string | null;
  /** Issue number whose panel the link asks for; null when none. */
  issueNumber: number | null;
  /** WHICH panel to open on that issue — detail or workspace drawer. */
  panel: IssuePanel;
  /** The project the slug resolved to, once known (guards the issue step). */
  targetProjectId: string | null;
  /** True once the project part has been applied (or had nothing to apply). */
  projectSettled: boolean;
  /** True once the issue part has been ATTEMPTED — success or not. */
  issueSettled: boolean;
  /** The slug named a project that does not exist; the URL is misleading. */
  unresolved: boolean;
}

export function createPendingDeepLink(parsed: {
  projectSlug: string | null;
  issueNumber: number | null;
  panel?: IssuePanel | null;
}): PendingDeepLink {
  return {
    projectSlug: parsed.projectSlug,
    issueNumber: parsed.issueNumber,
    panel: parsed.panel ?? "issue",
    targetProjectId: null,
    projectSettled: parsed.projectSlug === null,
    issueSettled: parsed.issueNumber === null,
    unresolved: false,
  };
}

/** A deep link is settled once neither half has anything left to apply. */
export function isDeepLinkSettled(pending: PendingDeepLink): boolean {
  return pending.projectSettled && pending.issueSettled;
}

export type DeepLinkProjectStep =
  /** Projects have not loaded yet — hold the link and try again. */
  | { kind: "wait" }
  /** Nothing to do (no project in the link, or already applied). */
  | { kind: "none" }
  /** Switch the active project (a server-side preference — go via the handler). */
  | { kind: "switch"; projectId: string }
  /** The link names the project that is already active. */
  | { kind: "already-active"; projectId: string }
  /** The slug matches no known project — fall back to the active project. */
  | { kind: "unresolved" };

export function planDeepLinkProject(
  pending: PendingDeepLink,
  projects: SlugProject[],
  activeProjectId: string | null,
): DeepLinkProjectStep {
  if (pending.projectSettled || !pending.projectSlug) return { kind: "none" };
  if (projects.length === 0) return { kind: "wait" };
  const projectId = resolveProjectIdFromSlug(pending.projectSlug, projects);
  if (!projectId) return { kind: "unresolved" };
  return projectId === activeProjectId
    ? { kind: "already-active", projectId }
    : { kind: "switch", projectId };
}

export type DeepLinkIssueStep =
  /** The board for the target project has not loaded yet. */
  | { kind: "wait" }
  | { kind: "none" }
  | { kind: "open"; issueNumber: number; panel: IssuePanel };

export function planDeepLinkIssue(
  pending: PendingDeepLink,
  ctx: { boardLoaded: boolean; activeProjectId: string | null },
): DeepLinkIssueStep {
  if (pending.issueSettled || pending.issueNumber === null) return { kind: "none" };
  if (!pending.projectSettled) return { kind: "wait" };
  // A pending project SWITCH sets activeProjectId synchronously but the board
  // arrives later; opening against the outgoing project's columns would show
  // the wrong ticket, so wait for the target project's board.
  if (pending.targetProjectId && pending.targetProjectId !== ctx.activeProjectId) return { kind: "wait" };
  if (!ctx.boardLoaded) return { kind: "wait" };
  return { kind: "open", issueNumber: pending.issueNumber, panel: pending.panel };
}

/* ------------------------------------------------------------------ *
 * Outbound: what the address bar should say for the current state
 * ------------------------------------------------------------------ */

export type HistoryAction = "none" | "push" | "replace";

export interface UrlSyncPlan {
  path: string;
  action: HistoryAction;
}

export interface UrlSyncInput {
  /** `window.location.pathname` (no search/hash — those are preserved verbatim). */
  currentPath: string;
  projects: SlugProject[];
  activeProjectId: string | null;
  view: ViewMode;
  /**
   * The active tab of a tabbed container view (#446), or null when it is not
   * known yet — the container owns that state and mounts after the route does.
   * Ignored for a view that has no tabs.
   */
  tab?: string | null;
  issueNumber: number | null;
  /**
   * Which issue-bearing panel is open. Two panels can hold an issue — the
   * detail panel and the workspace drawer — and the URL has to say which, or a
   * reload reopens the wrong one (the drawer was invisible to the URL entirely).
   */
  panel?: IssuePanel | null;
  /**
   * Force `replace` for a write that is not a user navigation: coalescing a
   * multi-step programmatic navigation, restoring from popstate, or correcting
   * a URL whose slug resolved to nothing.
   */
  preferReplace?: boolean;
}

/**
 * The legacy `?tab=` link, promoted into the path (#446).
 *
 * Reading the param inside the container view is too late, and MEASURED so:
 * the container mounts ~500ms after load, while the outbound sync canonicalises
 * the tabless path to the registry default at ~400ms. By mount the path names
 * "throughput" explicitly, so the param can never win — and honouring it then
 * would also PUSH a second history entry for one inbound link.
 *
 * So the upgrade happens at router INIT, during the first render, before any
 * sync effect can run: the param's tab is written into the path and the param
 * is dropped. Returns null when there is nothing to do (no param, unknown view,
 * a view without tabs, a tab that does not exist, or a path that already names
 * a tab explicitly — an explicit path tab outranks the legacy param).
 */
export function planLegacyTabParamUpgrade(
  pathname: string,
  search: string,
): { pathname: string; search: string } | null {
  const params = new URLSearchParams(search ?? "");
  const requested = params.get("tab");
  if (requested === null) return null;

  params.delete("tab");
  const nextSearch = params.toString() ? `?${params.toString()}` : "";

  const current = parseAppPath(pathname);
  if (
    current.view === null ||
    current.tabIsExplicit ||
    !viewHasTabs(current.view) ||
    !isRoutableViewTab(current.view, requested)
  ) {
    // Nothing usable in the param, but it must still not linger in the URL —
    // two statements of the same fact, one of them ignored.
    return { pathname: normalizePathname(pathname), search: nextSearch };
  }

  return {
    pathname: buildAppPath({
      projectSlug: current.projectSlug,
      view: current.view,
      tab: requested,
      issueNumber: current.issueNumber,
      panel: current.panel,
    }),
    search: nextSearch,
  };
}

function normalizePathname(pathname: string): string {
  const path = (pathname ?? "").split(/[?#]/, 1)[0] || "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Decide the next path and whether writing it is a push or a replace.
 *
 * Returns `none` when the URL already says the right thing, and — importantly —
 * when the active project's slug is not computable yet (projects still
 * loading). Rewriting before then would flatten a scoped inbound URL back to
 * `/board` and lose the link.
 */
/**
 * Which tab the URL should name for the current view.
 *
 * The container view mounts AFTER the route hook, so `active` is null on the
 * first pass — falling back to the tab already in the URL is what stops that
 * first pass from flattening an inbound `/analytics/burndown` to the default.
 * Only once nothing names a tab does the default apply.
 */
export function resolveSyncTab(
  view: ViewMode,
  active: string | null | undefined,
  currentTab: string | null,
): string | null {
  if (!viewHasTabs(view)) return null;
  if (isRoutableViewTab(view, active)) return active as string;
  if (isRoutableViewTab(view, currentTab)) return currentTab as string;
  return getDefaultViewTab(view);
}

export function planUrlSync(input: UrlSyncInput): UrlSyncPlan {
  const { currentPath, projects, activeProjectId, view, issueNumber } = input;
  const panel: IssuePanel | null = issueNumber === null ? null : input.panel ?? "issue";
  const current = parseAppPath(currentPath);
  const tab = resolveSyncTab(view, input.tab, current.view === view ? current.tab : null);
  const slug = activeProjectId ? buildProjectSlugMap(projects).get(activeProjectId) ?? null : null;
  // No slug and no loaded projects = the projects query is still in flight.
  // Writing now would flatten a scoped inbound URL and lose the link.
  // (With projects loaded but no slug — no active project, or an archived one —
  // fall back to the flat path so view routing keeps working.)
  if (!slug && projects.length === 0) return { path: normalizePathname(currentPath), action: "none" };

  const path = buildAppPath({ projectSlug: slug, view, tab, issueNumber, panel });
  if (normalizePathname(currentPath) === path) return { path, action: "none" };
  if (input.preferReplace) return { path, action: "replace" };

  const sameTarget =
    current.view === view &&
    (current.tab ?? null) === tab &&
    (current.issueNumber ?? null) === (issueNumber ?? null) &&
    (current.panel ?? null) === panel;
  const currentIsActiveProject =
    current.projectSlug !== null &&
    activeProjectId !== null &&
    resolveProjectIdFromSlug(current.projectSlug, projects) === activeProjectId;

  // In-place upgrades, not navigations: a legacy flat path gaining its project
  // scope (`/board` -> `/p/<slug>/board`), an absorbed view's old path gaining
  // its container + tab (`/burndown` -> `/p/<slug>/analytics/burndown`), or a
  // raw-id/alias path canonicalised to the slug. None deserves a history entry.
  if (sameTarget && (current.projectSlug === null || currentIsActiveProject)) {
    return { path, action: "replace" };
  }
  return { path, action: "push" };
}

/* ------------------------------------------------------------------ *
 * One logical navigation == one history entry — moved to
 * lib/navigationBurst.ts (#465) so hooks/components can start a burst
 * without importing UP into routes/; re-exported here unchanged for this
 * module's own existing consumers (BoardPage.tsx, useBoardPageRoute.ts).
 * ------------------------------------------------------------------ */
export {
  type NavigationBurst,
  NAVIGATION_BURST_MS,
  createNavigationBurst,
  navigationBurst,
  markProgrammaticNavigation,
} from "../lib/navigationBurst.js";
