import { useCallback, useEffect, useState } from "react";
import { VIEW_IDS, type ViewMode } from "../lib/viewRegistry.js";
import { getAppRouteTab, getAppRouteView, getViewRoutePath } from "../lib/appRoutes.js";
import { NAVIGATE_VIEW_EVENT, type NavigateViewDetail } from "../lib/navigateView.js";
import { viewTabActions } from "../stores/viewTabStore.js";

interface BoardPageRouteState {
  viewMode: ViewMode;
  graphFocusIssueId: string | undefined;
  setGraphFocusIssueId: (issueId: string | undefined) => void;
  setViewMode: (mode: ViewMode) => void;
  navigateToViewRoute: (mode: ViewMode, replace?: boolean) => void;
  handleViewModeChange: (mode: ViewMode) => void;
}

export function useBoardPageRoute(): BoardPageRouteState {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const routeView = getAppRouteView(window.location.pathname);
    if (routeView) return routeView;
    const stored = localStorage.getItem("kanban-board-view");
    return VIEW_IDS.includes(stored as ViewMode) ? (stored as ViewMode) : "kanban";
  });

  const [graphFocusIssueId, setGraphFocusIssueId] = useState<string | undefined>(undefined);

  const navigateToViewRoute = useCallback((mode: ViewMode, replace = false) => {
    const nextPath = getViewRoutePath(mode);
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
    navigateToViewRoute(mode);
    if (mode !== "graph") {
      setGraphFocusIssueId(undefined);
    }
  }, [navigateToViewRoute]);

  // Legacy absorbed-view deep links (#234/#235): /burndown etc. resolve to a
  // container view; forward the tab to preselect so no old bookmark loses
  // information. One-shot on mount — the container consumes the request.
  useEffect(() => {
    const legacyTab = getAppRouteTab(window.location.pathname);
    if (legacyTab) viewTabActions.request(legacyTab.view, legacyTab.tab);
  }, []);

  // Programmatic navigation from lib-layer code (#300): toast/notification clicks
  // dispatch NAVIGATE_VIEW_EVENT because they cannot reach this hook's state.
  useEffect(() => {
    function handleNavigateEvent(e: Event) {
      const view = (e as CustomEvent<NavigateViewDetail>).detail?.view;
      if (view && VIEW_IDS.includes(view)) handleViewModeChange(view);
    }
    window.addEventListener(NAVIGATE_VIEW_EVENT, handleNavigateEvent);
    return () => window.removeEventListener(NAVIGATE_VIEW_EVENT, handleNavigateEvent);
  }, [handleViewModeChange]);

  useEffect(() => {
    function handlePopState() {
      const routeView = getAppRouteView(window.location.pathname);
      if (!routeView) return;
      const legacyTab = getAppRouteTab(window.location.pathname);
      if (legacyTab) viewTabActions.request(legacyTab.view, legacyTab.tab);
      setViewMode(routeView);
      localStorage.setItem("kanban-board-view", routeView);
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
