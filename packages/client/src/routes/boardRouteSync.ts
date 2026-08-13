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
import { buildAppPath, parseAppPath } from "../lib/appRoutes.js";
import { buildProjectSlugMap, resolveProjectIdFromSlug, type SlugProject } from "../lib/projectSlug.js";
import type { ViewMode } from "../lib/viewRegistry.js";

/* ------------------------------------------------------------------ *
 * Inbound: a deep link held until the data it names has loaded
 * ------------------------------------------------------------------ */

export interface PendingDeepLink {
  /** `/p/<slugOrId>` segment from the inbound URL; null when unscoped. */
  projectSlug: string | null;
  /** Issue number whose detail panel the link asks for; null when none. */
  issueNumber: number | null;
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
}): PendingDeepLink {
  return {
    projectSlug: parsed.projectSlug,
    issueNumber: parsed.issueNumber,
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
  | { kind: "open"; issueNumber: number };

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
  return { kind: "open", issueNumber: pending.issueNumber };
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
  issueNumber: number | null;
  /**
   * Force `replace` for a write that is not a user navigation: coalescing a
   * multi-step programmatic navigation, restoring from popstate, or correcting
   * a URL whose slug resolved to nothing.
   */
  preferReplace?: boolean;
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
export function planUrlSync(input: UrlSyncInput): UrlSyncPlan {
  const { currentPath, projects, activeProjectId, view, issueNumber } = input;
  const slug = activeProjectId ? buildProjectSlugMap(projects).get(activeProjectId) ?? null : null;
  // No slug and no loaded projects = the projects query is still in flight.
  // Writing now would flatten a scoped inbound URL and lose the link.
  // (With projects loaded but no slug — no active project, or an archived one —
  // fall back to the flat path so view routing keeps working.)
  if (!slug && projects.length === 0) return { path: normalizePathname(currentPath), action: "none" };

  const path = buildAppPath({ projectSlug: slug, view, issueNumber });
  if (normalizePathname(currentPath) === path) return { path, action: "none" };
  if (input.preferReplace) return { path, action: "replace" };

  const current = parseAppPath(currentPath);
  const sameTarget = current.view === view && (current.issueNumber ?? null) === (issueNumber ?? null);
  const currentIsActiveProject =
    current.projectSlug !== null &&
    activeProjectId !== null &&
    resolveProjectIdFromSlug(current.projectSlug, projects) === activeProjectId;

  // In-place upgrades, not navigations: a legacy flat path gaining its project
  // scope (`/board` -> `/p/<slug>/board`), or a raw-id/alias path being
  // canonicalised to the slug. Neither deserves a history entry.
  if (sameTarget && (current.projectSlug === null || currentIsActiveProject)) {
    return { path, action: "replace" };
  }
  return { path, action: "push" };
}

/* ------------------------------------------------------------------ *
 * One logical navigation == one history entry
 * ------------------------------------------------------------------ */

export interface NavigationBurst {
  /** Start a burst: the first URL write may push, later ones replace. */
  mark(now: number, windowMs?: number): void;
  /** Start a burst in which NO write may push (popstate restore). */
  markSilent(now: number, windowMs?: number): void;
  /** True when the next write must replace rather than push. */
  isCoalescing(now: number): boolean;
  /** Record that a push happened, so the rest of the burst coalesces. */
  notePush(now: number): void;
}

/** How long the steps of one logical navigation are treated as a single burst. */
export const NAVIGATION_BURST_MS = 1000;

export function createNavigationBurst(defaultWindowMs = NAVIGATION_BURST_MS): NavigationBurst {
  let openUntil = 0;
  let pushUsed = true;
  return {
    mark(now, windowMs = defaultWindowMs) {
      // Re-marking INSIDE an open burst only extends it — the steps of one
      // logical navigation each mark, and must still share a single entry.
      if (now >= openUntil) pushUsed = false;
      openUntil = now + windowMs;
    },
    markSilent(now, windowMs = defaultWindowMs) {
      openUntil = now + windowMs;
      pushUsed = true;
    },
    isCoalescing(now) {
      return now < openUntil && pushUsed;
    },
    notePush(now) {
      if (now < openUntil) pushUsed = true;
    },
  };
}

/**
 * Shared by every place that starts a multi-step navigation: the three
 * CustomEvent handlers (SELECT_PROJECT / NAVIGATE_VIEW / FOCUS_ISSUE) and the
 * popstate restore. They live in different modules, so the burst is a module
 * singleton rather than hook state.
 */
export const navigationBurst = createNavigationBurst();

/** Mark that a programmatic, multi-step navigation is starting. */
export function markProgrammaticNavigation(now: number = Date.now()): void {
  navigationBurst.mark(now);
}
