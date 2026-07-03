// Client board store — bulk-selection slice (#958, step 3 of the BoardPage
// decentralisation started by boardSelectionStore/#905).
//
// Holds the multi-select state (ctrl/shift-click on cards) plus the transient
// "pending" indicator sets (issues being created optimistically, issues whose
// workspace is starting). Previously these lived as useState on BoardPage /
// useBoardBulkSelection and their setters were injected into
// useBoardRealtimeController, createBoardIssueActions and the WorkspacePanel
// callbacks; those now write the store directly.
//
// The derived values that need board data (selectedBoardIssues, archived
// check) and the async bulk mutations stay in the useBoardBulkSelection hook —
// this store owns only the raw state.
import { create } from "zustand";
import type { SetStateAction } from "react";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

export interface BoardBulkSelectionState {
  /** Issue ids currently multi-selected on the kanban board. */
  selectedBoardIssueIds: Set<string>;
  /** Anchor for shift-click range selection. */
  lastSelectedBoardIssueId: string | null;
  /** A bulk mutation is in flight (disables the bulk action bar). */
  boardBulkUpdating: boolean;
  /** Optimistically created issues awaiting their real id. */
  pendingIssueIds: Set<string>;
  /** Issues whose workspace is currently being created/launched. */
  pendingWorkspaceIssueIds: Set<string>;

  addToSelection: (issueId: string) => void;
  toggleSelection: (issueId: string) => void;
  /** Shift-click range select within the given visible-issue order. */
  rangeSelect: (orderedIssueIds: string[], issueId: string) => void;
  clearSelection: () => void;
  /** Raw setter (used by the visibility prune; accepts an updater like useState). */
  setSelectedBoardIssueIds: (next: SetStateAction<Set<string>>) => void;
  setBoardBulkUpdating: (value: boolean) => void;
  setPendingIssueIds: (next: SetStateAction<Set<string>>) => void;
  setPendingWorkspaceIssueIds: (next: SetStateAction<Set<string>>) => void;
}

export const useBoardBulkSelectionStore = create<BoardBulkSelectionState>((set, get) => ({
  selectedBoardIssueIds: new Set<string>(),
  lastSelectedBoardIssueId: null,
  boardBulkUpdating: false,
  pendingIssueIds: new Set<string>(),
  pendingWorkspaceIssueIds: new Set<string>(),

  addToSelection: (issueId) => {
    const next = new Set(get().selectedBoardIssueIds);
    next.add(issueId);
    set({ selectedBoardIssueIds: next, lastSelectedBoardIssueId: issueId });
  },
  toggleSelection: (issueId) => {
    const next = new Set(get().selectedBoardIssueIds);
    if (next.has(issueId)) {
      next.delete(issueId);
    } else {
      next.add(issueId);
    }
    set({ selectedBoardIssueIds: next, lastSelectedBoardIssueId: issueId });
  },
  rangeSelect: (orderedIssueIds, issueId) => {
    const { selectedBoardIssueIds, lastSelectedBoardIssueId } = get();
    const anchorIndex = lastSelectedBoardIssueId
      ? orderedIssueIds.indexOf(lastSelectedBoardIssueId)
      : -1;
    const currentIndex = orderedIssueIds.indexOf(issueId);
    const next = new Set(selectedBoardIssueIds);
    if (anchorIndex >= 0 && currentIndex >= 0) {
      const [start, end] = anchorIndex < currentIndex
        ? [anchorIndex, currentIndex]
        : [currentIndex, anchorIndex];
      for (const id of orderedIssueIds.slice(start, end + 1)) next.add(id);
    } else {
      next.add(issueId);
    }
    set({ selectedBoardIssueIds: next, lastSelectedBoardIssueId: issueId });
  },
  clearSelection: () =>
    set({ selectedBoardIssueIds: new Set<string>(), lastSelectedBoardIssueId: null }),
  setSelectedBoardIssueIds: (next) =>
    set({ selectedBoardIssueIds: resolve(next, get().selectedBoardIssueIds) }),
  setBoardBulkUpdating: (value) => set({ boardBulkUpdating: value }),
  setPendingIssueIds: (next) =>
    set({ pendingIssueIds: resolve(next, get().pendingIssueIds) }),
  setPendingWorkspaceIssueIds: (next) =>
    set({ pendingWorkspaceIssueIds: resolve(next, get().pendingWorkspaceIssueIds) }),
}));

/**
 * Non-reactive access for factory hooks and services that previously received
 * these setters as injected props (createIssueService, useBoardRefetch,
 * createBoardIssueActions, WorkspacePanel callbacks).
 */
export const boardBulkSelectionActions = {
  clearSelection: () => useBoardBulkSelectionStore.getState().clearSelection(),
  setPendingIssueIds: (next: SetStateAction<Set<string>>) =>
    useBoardBulkSelectionStore.getState().setPendingIssueIds(next),
  setPendingWorkspaceIssueIds: (next: SetStateAction<Set<string>>) =>
    useBoardBulkSelectionStore.getState().setPendingWorkspaceIssueIds(next),
};
