// Client board store — selection slice (#905, step 1 of the BoardPage
// decentralisation in #895/B).
//
// Before this store, the "what panel is open" state — the selected issue
// (detail panel) and the workspace-panel target plus its open-mode flags —
// lived as 5 useState hooks on BoardPage and was prop-drilled (~12 props) down
// through BoardPageView into a dozen hooks and child components. That band of
// props is exactly the highest-fan-out slice the parent ticket calls out.
//
// This is a thin, selector-based zustand store (no provider tree). Components
// read what they need via selectors (`useBoardSelectionStore(s => s.selectedIssue)`)
// and the orchestration hooks call the actions directly instead of receiving
// setters as props. The action set is intentionally shaped to mirror the
// previous setter signatures (`setSelectedIssue`, `setWorkspaceIssue`, …) so the
// migration is behaviour-preserving at every call site, plus a couple of
// composite actions for the recurring multi-set transitions.
//
// The follow-up slices now exist (#958): filters in boardFilterStore.ts, bulk
// selection + pending indicators in boardBulkSelectionStore.ts, and the
// keyboard cursor in boardCursorStore.ts — keep each concern in its own store,
// do NOT fold them in here.
import { create } from "zustand";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  shouldAutoOpenWorkspacePanel,
  type WorkspaceAutoOpenSelection,
} from "../lib/workspaceAutoOpen.js";

/** Workspace panel deep-link target (open a specific workspace/session). */
export type WorkspaceInitial = { workspaceId: string; sessionId?: string } | null;

export interface BoardSelectionState {
  /** Issue shown in the detail panel (right-hand slide-in). `null` = closed. */
  selectedIssue: IssueWithStatus | null;
  /** Issue whose workspace panel is open. `null` = closed. */
  workspaceIssue: IssueWithStatus | null;
  /** Deep-link target when the workspace panel opens onto a specific workspace/session. */
  workspaceInitial: WorkspaceInitial;
  /** Open the workspace panel straight onto the diff view. */
  workspaceInitialDiff: boolean;
  /** Open the workspace panel straight onto the create-workspace form. */
  workspaceOpenCreate: boolean;

  // --- 1:1 setters (mirror the previous useState setters) -----------------
  setSelectedIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceInitial: (init: WorkspaceInitial) => void;
  setWorkspaceInitialDiff: (v: boolean) => void;
  setWorkspaceOpenCreate: (open: boolean) => void;
}

export const useBoardSelectionStore = create<BoardSelectionState>((set) => ({
  selectedIssue: null,
  workspaceIssue: null,
  workspaceInitial: null,
  workspaceInitialDiff: false,
  workspaceOpenCreate: false,

  setSelectedIssue: (issue) => set({ selectedIssue: issue }),
  setWorkspaceIssue: (issue) => set({ workspaceIssue: issue }),
  setWorkspaceInitial: (init) => set({ workspaceInitial: init }),
  setWorkspaceInitialDiff: (v) => set({ workspaceInitialDiff: v }),
  setWorkspaceOpenCreate: (open) => set({ workspaceOpenCreate: open }),
}));

/**
 * Non-reactive access to the selection actions/state for use outside React
 * render (event handlers, factory hooks that receive plain callables). Reads via
 * `getState()` are a snapshot — fine for actions, do not use for rendering.
 */
export const boardSelectionActions = {
  setSelectedIssue: (issue: IssueWithStatus | null) =>
    useBoardSelectionStore.getState().setSelectedIssue(issue),
  setWorkspaceIssue: (issue: IssueWithStatus | null) =>
    useBoardSelectionStore.getState().setWorkspaceIssue(issue),
  setWorkspaceInitial: (init: WorkspaceInitial) =>
    useBoardSelectionStore.getState().setWorkspaceInitial(init),
  setWorkspaceInitialDiff: (v: boolean) =>
    useBoardSelectionStore.getState().setWorkspaceInitialDiff(v),
  setWorkspaceOpenCreate: (open: boolean) =>
    useBoardSelectionStore.getState().setWorkspaceOpenCreate(open),
};

/** Current selection reduced to what the #973 auto-open decision needs. */
export function captureWorkspaceAutoOpenSelection(): WorkspaceAutoOpenSelection {
  const state = useBoardSelectionStore.getState();
  return {
    selectedIssueId: state.selectedIssue?.id ?? null,
    workspaceIssueId: state.workspaceIssue?.id ?? null,
  };
}

/**
 * #973 — open the workspace drawer for a just-launched issue ONLY if the user
 * has not moved on while the launch was in flight. `before` is the snapshot
 * `captureWorkspaceAutoOpenSelection()` returned before the request was issued.
 * Returns whether the panel was opened, so a caller can adapt its feedback.
 */
export function openWorkspacePanelIfUndisturbed(
  before: WorkspaceAutoOpenSelection,
  issue: IssueWithStatus,
  initial: WorkspaceInitial,
): boolean {
  const allowed = shouldAutoOpenWorkspacePanel({
    before,
    after: captureWorkspaceAutoOpenSelection(),
    launchedIssueId: issue.id,
  });
  if (!allowed) return false;
  const state = useBoardSelectionStore.getState();
  state.setSelectedIssue(null);
  state.setWorkspaceIssue(issue);
  state.setWorkspaceInitial(initial);
  state.setWorkspaceOpenCreate(false);
  return true;
}
