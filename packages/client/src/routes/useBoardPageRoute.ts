import { useCallback, useEffect, useRef, useState } from "react";
import { VIEW_IDS, type ViewMode } from "../lib/viewRegistry.js";
import { buildAppPath, getAppRouteTab, parseAppPath, type IssuePanel } from "../lib/appRoutes.js";
import { buildProjectSlugMap, resolveProjectIdFromSlug, type SlugProject } from "../lib/projectSlug.js";
import { NAVIGATE_VIEW_EVENT, type NavigateViewDetail } from "../lib/navigateView.js";
import { useViewTabStore, viewTabActions } from "../stores/viewTabStore.js";
import {
  createPendingDeepLink,
  isDeepLinkSettled,
  navigationBurst,
  planDeepLinkIssue,
  planDeepLinkProject,
  planLegacyTabParamUpgrade,
  planUrlSync,
  type PendingDeepLink,
} from "./boardRouteSync.js";

interface BoardPageRouteState {
  viewMode: ViewMode;
  graphFocusIssueId: string | undefined;
  setGraphFocusIssueId: (issueId: string | undefined) => void;
  setViewMode: (mode: ViewMode) => void;
  navigateToViewRoute: (mode: ViewMode, replace?: boolean) => void;
  handleViewModeChange: (mode: ViewMode) => void;
}

export interface BoardPageRouteOptions {
  /** Loaded projects; empty while the projects query is in flight. */
  projects: SlugProject[];
  activeProjectId: string | null;
  /** Issue number of the open issue-bearing panel, or null when none is open. */
  selectedIssueNumber: number | null;
  /**
   * WHICH panel that issue number belongs to. The workspace drawer is a second
   * issue-bearing panel; without this the URL claimed nothing was open while a
   * full panel was on screen, and a reload could not restore it.
   */
  openPanel: IssuePanel | null;
  /**
   * The board columns. Only their identity/length is read — it is the signal
   * that this project's board has arrived, so a held issue deep link can be
   * applied.
   */
  columns: readonly unknown[];
  /** Switch the active project (server-side preference). */
  onSelectProject: (projectId: string) => void | Promise<void>;
  /**
   * Open issue #n's panel — the detail panel or the workspace drawer, as the
   * URL names. Returns false when the issue is not on the board.
   */
  onOpenIssueNumber: (issueNumber: number, panel: IssuePanel) => boolean;
  /** Close whichever issue panel is open (popstate back past an `/issue/<n>` entry). */
  onCloseIssue: () => void;
}

/**
 * Rewrite `…/analytics?tab=burndown` to `…/analytics/burndown` in place, once,
 * before anything else reads the URL. A React 18 strict-mode double render
 * calls this twice; the second call is a no-op because the param is gone.
 */
function upgradeLegacyTabParam(): void {
  const next = planLegacyTabParamUpgrade(window.location.pathname, window.location.search);
  if (!next) return;
  window.history.replaceState(null, "", `${next.pathname}${next.search}${window.location.hash}`);
}

const NO_PROJECTS: SlugProject[] = [];
const NO_COLUMNS: readonly unknown[] = [];

/**
 * Owns the board's URL (#446): the address bar reflects (project, view, open
 * issue), inbound deep links win over the stored view preference, and
 * back/forward restores all three.
 *
 * The decision logic is pure and unit-tested in ./boardRouteSync.ts; this hook
 * is the wiring — refs so the window listeners register once and still read
 * current state, and effects that re-check a held deep link whenever the data
 * it needs arrives.
 */
export function useBoardPageRoute(options?: Partial<BoardPageRouteOptions>): BoardPageRouteState {
  const projects = options?.projects ?? NO_PROJECTS;
  const activeProjectId = options?.activeProjectId ?? null;
  const selectedIssueNumber = options?.selectedIssueNumber ?? null;
  const openPanel = options?.openPanel ?? null;
  const columns = options?.columns ?? NO_COLUMNS;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    // Promote a legacy `?tab=` into the path FIRST — during this first render,
    // while nothing has run that could flatten the path to the default tab.
    upgradeLegacyTabParam();
    // A deep link beats the stored preference. `parseAppPath` still reports the
    // project for a path whose tail is junk, so an unknown view segment falls
    // through to the preference rather than blanking the board.
    const routeView = parseAppPath(window.location.pathname).view;
    if (routeView) return routeView;
    const stored = localStorage.getItem("kanban-board-view");
    return VIEW_IDS.includes(stored as ViewMode) ? (stored as ViewMode) : "kanban";
  });

  const [graphFocusIssueId, setGraphFocusIssueId] = useState<string | undefined>(undefined);

  // The tab the mounted container view is showing (#446). Null until it mounts,
  // and for every view that has no tabs — planUrlSync handles both.
  const activeTab = useViewTabStore((s) => s.active[viewMode] ?? null);

  // Callbacks BoardPage owns. Assigned on every render (same pattern as
  // BoardPage's own projectChangeRef) so the effects and window listeners below
  // never need them as dependencies.
  const handlersRef = useRef<Pick<BoardPageRouteOptions, "onSelectProject" | "onOpenIssueNumber" | "onCloseIssue">>({
    onSelectProject: () => {},
    onOpenIssueNumber: () => false,
    onCloseIssue: () => {},
  });
  handlersRef.current = {
    onSelectProject: options?.onSelectProject ?? (() => {}),
    onOpenIssueNumber: options?.onOpenIssueNumber ?? (() => false),
    onCloseIssue: options?.onCloseIssue ?? (() => {}),
  };

  // Current data, for the popstate listener (registered once).
  const dataRef = useRef({ projects, activeProjectId });
  dataRef.current = { projects, activeProjectId };

  // The inbound deep link, held until the data it names has loaded.
  const pendingRef = useRef<PendingDeepLink>(createPendingDeepLink(parseAppPath(window.location.pathname)));

  const navigateToViewRoute = useCallback((mode: ViewMode, replace = false) => {
    const { projects: currentProjects, activeProjectId: currentProjectId } = dataRef.current;
    const slug = currentProjectId
      ? buildProjectSlugMap(currentProjects).get(currentProjectId) ?? null
      : null;
    const nextPath = buildAppPath({ projectSlug: slug, view: mode });
    if (window.location.pathname === nextPath) return;
    const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
    if (replace) {
      window.history.replaceState(null, "", nextUrl);
    } else {
      window.history.pushState(null, "", nextUrl);
    }
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("kanban-board-view", mode);
    // The URL is written by the state-sync effect below, not here — that is what
    // makes event-driven navigation produce a pasteable URL for free.
    if (mode !== "graph") {
      setGraphFocusIssueId(undefined);
    }
  }, []);

  // Inbound tab (#446) and legacy absorbed-view deep links (#234/#235):
  // /p/<slug>/analytics/burndown, /burndown and /p/<slug>/burndown all name a
  // container view + tab; forward it so no old bookmark loses information and a
  // pasted canonical URL opens the tab it names. One-shot on mount — the
  // container consumes the request.
  useEffect(() => {
    const parsed = parseAppPath(window.location.pathname);
    if (parsed.view && parsed.tab) {
      viewTabActions.request(parsed.view, parsed.tab);
      return;
    }
    const legacyTab = getAppRouteTab(window.location.pathname);
    if (legacyTab) viewTabActions.request(legacyTab.view, legacyTab.tab);
  }, []);

  // Programmatic navigation from lib-layer code (#300): toast/notification clicks
  // dispatch NAVIGATE_VIEW_EVENT because they cannot reach this hook's state.
  useEffect(() => {
    function handleNavigateEvent(e: Event) {
      const view = (e as CustomEvent<NavigateViewDetail>).detail?.view;
      if (view && VIEW_IDS.includes(view)) {
        // Part of a project -> view -> issue chain: one back-step, not three.
        navigationBurst.mark(Date.now());
        handleViewModeChange(view);
      }
    }
    window.addEventListener(NAVIGATE_VIEW_EVENT, handleNavigateEvent);
    return () => window.removeEventListener(NAVIGATE_VIEW_EVENT, handleNavigateEvent);
  }, [handleViewModeChange]);

  // ---- Inbound deep link: apply each half as soon as its data arrives. ----
  useEffect(() => {
    const pending = pendingRef.current;
    if (isDeepLinkSettled(pending)) return;

    if (!pending.projectSettled) {
      const step = planDeepLinkProject(pending, projects, activeProjectId);
      if (step.kind === "wait") return;
      pending.projectSettled = true;
      if (step.kind === "unresolved") {
        // Nothing to switch to — stay on the active project, and let the sync
        // effect replace the misleading slug with where the user actually is.
        pending.unresolved = true;
        pending.issueSettled = true;
        pending.issueNumber = null;
      } else if (step.kind === "switch") {
        pending.targetProjectId = step.projectId;
        void handlersRef.current.onSelectProject(step.projectId);
        return; // the board for the new project has to load first
      } else if (step.kind === "already-active") {
        pending.targetProjectId = step.projectId;
      }
    }

    const issueStep = planDeepLinkIssue(pending, { boardLoaded: columns.length > 0, activeProjectId });
    if (issueStep.kind === "open") {
      // Settle first, unconditionally: applied ONCE, so neither a refetch nor a
      // re-render can reopen a panel the user has since closed.
      pending.issueSettled = true;
      // Not on this board (deleted, or a bad number): correct the URL in place
      // rather than pushing an entry for a panel that never opened.
      if (!handlersRef.current.onOpenIssueNumber(issueStep.issueNumber, issueStep.panel)) {
        pending.unresolved = true;
      }
    }
  }, [projects, activeProjectId, columns]);

  // ---- Outbound: the address bar reflects (project, view, tab, issue). ----
  useEffect(() => {
    const pending = pendingRef.current;
    if (!isDeepLinkSettled(pending)) return; // don't overwrite a link still being applied
    const now = Date.now();
    const plan = planUrlSync({
      currentPath: window.location.pathname,
      projects,
      activeProjectId,
      view: viewMode,
      tab: activeTab,
      issueNumber: selectedIssueNumber,
      panel: openPanel,
      preferReplace: pending.unresolved || navigationBurst.isCoalescing(now),
    });
    if (plan.action === "none") return;
    pending.unresolved = false;
    const nextUrl = `${plan.path}${window.location.search}${window.location.hash}`;
    if (plan.action === "replace") {
      window.history.replaceState(null, "", nextUrl);
    } else {
      window.history.pushState(null, "", nextUrl);
      navigationBurst.notePush(now);
    }
  }, [projects, activeProjectId, viewMode, activeTab, selectedIssueNumber, openPanel, columns]);

  // ---- Back/forward across all three dimensions. ----
  useEffect(() => {
    function handlePopState() {
      const parsed = parseAppPath(window.location.pathname);
      if (!parsed.view && !parsed.projectSlug) return;
      // The entry we are moving to already exists: every URL write triggered by
      // the state changes below must replace, never push.
      navigationBurst.markSilent(Date.now());

      const { projects: currentProjects, activeProjectId: currentProjectId } = dataRef.current;
      let switchingTo: string | null = null;
      if (parsed.projectSlug) {
        const projectId = resolveProjectIdFromSlug(parsed.projectSlug, currentProjects);
        if (projectId && projectId !== currentProjectId) {
          switchingTo = projectId;
          void handlersRef.current.onSelectProject(projectId);
        }
      }

      if (parsed.view) {
        if (parsed.tab) viewTabActions.request(parsed.view, parsed.tab);
        setViewMode(parsed.view);
        localStorage.setItem("kanban-board-view", parsed.view);
      }

      if (switchingTo) {
        // The board is being replaced; hand the issue to the pending machinery,
        // which waits for the new project's columns.
        pendingRef.current = {
          ...createPendingDeepLink({
            projectSlug: null,
            issueNumber: parsed.issueNumber,
            panel: parsed.panel,
          }),
          targetProjectId: switchingTo,
        };
        return;
      }
      if (parsed.issueNumber === null) {
        handlersRef.current.onCloseIssue();
      } else {
        handlersRef.current.onOpenIssueNumber(parsed.issueNumber, parsed.panel ?? "issue");
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return {
    viewMode,
    graphFocusIssueId,
    setGraphFocusIssueId,
    setViewMode,
    navigateToViewRoute,
    handleViewModeChange,
  };
}
