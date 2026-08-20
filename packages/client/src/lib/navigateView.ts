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

// #413: a place that NAMES an issue must be able to open it. The plugin loop pane said
// "1 ticket(s) still open" and linked nowhere, so finding out WHICH ticket meant querying
// the board API — which is how a stranded phantom went unnoticed. BoardPage holds the
// loaded columns (an issue panel needs the full row, not just a number), so it resolves
// the number and opens the detail panel.
export const FOCUS_ISSUE_EVENT = "kanban:focus-issue";

export interface FocusIssueDetail {
  issueId?: string;
  issueNumber?: number | null;
  /**
   * Which panel to open on that issue. Default (absent) = the detail panel.
   * A caller that names a workspace — e.g. an inbox "finished, waiting to land"
   * item — wants the workspace drawer, which is a different panel and now a
   * different URL (`/issue/<n>/workspace`).
   */
  panel?: "issue" | "workspace";
  /** The workspace the drawer should open onto, when one is named. */
  workspaceId?: string;
}

export function requestIssueFocus(detail: FocusIssueDetail): void {
  window.dispatchEvent(new CustomEvent<FocusIssueDetail>(FOCUS_ISSUE_EVENT, { detail }));
}
