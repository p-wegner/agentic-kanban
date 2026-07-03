// Client board store — keyboard-cursor slice (#958, step 4 of the BoardPage
// decentralisation started by boardSelectionStore/#905).
//
// Replaces the BoardPage useState + ref mirror (`keyboardCursorIssueIdRef`)
// that was threaded into useBoardKeyboardShortcuts, useBoardPanelNavigation,
// useBoardMiscHandlers and down the BoardKanbanView → BoardColumn →
// BoardColumnCard chain. Event handlers read the live value via `getState()`
// (the store IS the ref); components subscribe with selectors so only the
// affected cards re-render when the cursor moves.
import { create } from "zustand";

export interface BoardCursorState {
  /** Issue currently focused by keyboard navigation (arrow keys / vim keys). */
  keyboardCursorIssueId: string | null;
  setKeyboardCursorIssueId: (id: string | null) => void;
}

export const useBoardCursorStore = create<BoardCursorState>((set) => ({
  keyboardCursorIssueId: null,
  setKeyboardCursorIssueId: (id) => set({ keyboardCursorIssueId: id }),
}));

/** Non-reactive access for event handlers / factory hooks. */
export const boardCursorActions = {
  setKeyboardCursorIssueId: (id: string | null) =>
    useBoardCursorStore.getState().setKeyboardCursorIssueId(id),
  /** Live read (replaces the old ref mirror). Do not use for rendering. */
  getKeyboardCursorIssueId: () =>
    useBoardCursorStore.getState().keyboardCursorIssueId,
};
