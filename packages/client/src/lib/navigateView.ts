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

// #323: cross-project deep links (inbox gate entries, sticky gate toasts) must be
// able to switch the ACTIVE PROJECT before navigating to a view — otherwise the
// user lands on the requested view of the wrong project ("No plugins enabled").
// Same dispatch pattern as view navigation: BoardPage owns handleProjectChange
// and performs the actual switch.
export const SELECT_PROJECT_EVENT = "kanban:select-project";

export interface SelectProjectDetail {
  projectId: string;
}

export function requestProjectSelection(projectId: string): void {
  window.dispatchEvent(new CustomEvent<SelectProjectDetail>(SELECT_PROJECT_EVENT, { detail: { projectId } }));
}
