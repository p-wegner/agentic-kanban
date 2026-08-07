// Programmatic view navigation from OUTSIDE the component tree (#300): lib-layer code
// (toast clicks, desktop-notification clicks, WS handlers) cannot reach BoardPage's
// handleViewModeChange, so it dispatches this window event and useBoardPageRoute —
// which owns the view-mode state — performs the actual switch.
import type { ViewMode } from "./viewRegistry.js";

export const NAVIGATE_VIEW_EVENT = "kanban:navigate-view";

export interface NavigateViewDetail {
  view: ViewMode;
}

export function requestViewNavigation(view: ViewMode): void {
  window.dispatchEvent(new CustomEvent<NavigateViewDetail>(NAVIGATE_VIEW_EVENT, { detail: { view } }));
}
