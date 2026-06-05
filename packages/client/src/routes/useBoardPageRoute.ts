import { useCallback, useEffect, useState } from "react";
import { VIEW_IDS, type ViewMode } from "../lib/viewRegistry.js";
import { getAppRouteView, getViewRoutePath } from "../lib/appRoutes.js";

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

  useEffect(() => {
    function handlePopState() {
      const routeView = getAppRouteView(window.location.pathname);
      if (!routeView) return;
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
