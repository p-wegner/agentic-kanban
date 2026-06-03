/**
 * Compute the sortOrder for a card dropped at `beforeIndex` within an ordered list.
 *
 * - beforeIndex === 0: place before the first card (first.sortOrder - 100)
 * - 0 < beforeIndex < length: place between two cards (midpoint)
 * - beforeIndex === length: place after the last card (last.sortOrder + 100)
 */
export function computeDropSortOrder(
  sortOrders: number[],
  beforeIndex: number,
): number {
  if (sortOrders.length === 0) return 0;
  if (beforeIndex === 0) return sortOrders[0] - 100;
  if (beforeIndex >= sortOrders.length) return sortOrders[sortOrders.length - 1] + 100;
  return Math.round((sortOrders[beforeIndex - 1] + sortOrders[beforeIndex]) / 2);
}

/**
 * Apply an in-column reorder optimistically: returns a new issues array
 * with the moved issue placed at the given sortOrder, re-sorted by sortOrder.
 */
export function applyReorderOptimistic<T extends { id: string; sortOrder: number }>(
  issues: T[],
  movedId: string,
  newSortOrder: number,
): T[] {
  return issues
    .map((issue) =>
      issue.id === movedId ? { ...issue, sortOrder: newSortOrder } : issue,
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
