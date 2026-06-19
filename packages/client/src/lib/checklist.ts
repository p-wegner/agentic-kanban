// Pure acceptance-criteria checklist transforms.
//
// The React section component (IssueChecklistSection) owns state + persistence;
// the list mutation logic lives here as pure functions so it is independently
// unit-testable (the repo convention — cf. ticketTrailCore.ts, boardColumnSort.ts).

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

/** Default id generator. Injectable so tests can be deterministic. */
export function defaultChecklistItemId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Append a new item built from `text`. Returns `null` when the trimmed text is
 * empty (nothing to add) so callers can short-circuit without mutating state.
 */
export function addChecklistItem(
  list: ChecklistItem[],
  text: string,
  genId: () => string = defaultChecklistItemId,
): ChecklistItem[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return [...list, { id: genId(), text: trimmed, completed: false }];
}

/** Flip the `completed` flag of one item, returning a new list. */
export function toggleChecklistItem(list: ChecklistItem[], itemId: string): ChecklistItem[] {
  return list.map((item) => (item.id === itemId ? { ...item, completed: !item.completed } : item));
}

/** Drop one item by id, returning a new list. */
export function removeChecklistItem(list: ChecklistItem[], itemId: string): ChecklistItem[] {
  return list.filter((item) => item.id !== itemId);
}

export interface ChecklistProgress {
  done: number;
  total: number;
  allComplete: boolean;
}

/** Completion summary used for the "n/m" badge. */
export function checklistProgress(list: ChecklistItem[]): ChecklistProgress {
  const total = list.length;
  const done = list.filter((item) => item.completed).length;
  return { done, total, allComplete: total > 0 && done === total };
}
