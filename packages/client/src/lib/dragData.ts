/**
 * Typed board drag-and-drop payload — set on card drag start, read by drop targets.
 *
 * Why a module-level store and not HTML5 dataTransfer: dataTransfer.getData() only
 * returns the payload inside the `drop` event, but the board needs the dragged
 * issue's id DURING `dragover` (to show the dependency-link affordance on Shift,
 * and to decide agent-slot eligibility). This was a `window.__dragData` global,
 * read via untyped `(window as unknown as Record<string, unknown>).__dragData`
 * casts in 6 places across 3 components. This module gives it one typed,
 * encapsulated home so the contract can't drift and the casts disappear.
 */
export interface BoardDragPayload {
  issueId: string;
  sourceStatusId: string;
}

let current: BoardDragPayload | null = null;

export function setBoardDragData(payload: BoardDragPayload): void {
  current = payload;
}

export function getBoardDragData(): BoardDragPayload | null {
  return current;
}

export function clearBoardDragData(): void {
  current = null;
}
