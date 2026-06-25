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
// Subsequent slices (filters, bulk selection, keyboard cursor) move into their
// own stores in follow-up PRs — do NOT fold them in here.
import { create } from "zustand";
import type { IssueWithStatus } from "@agentic-kanban/shared";

/** Workspace panel deep-link target (open a specific workspace/session). */
export type WorkspaceInitial = { workspaceId: string; sessionId: string } | null;

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
