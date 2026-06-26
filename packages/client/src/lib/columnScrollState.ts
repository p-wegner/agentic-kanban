/** Vertical-scroll position of a column's scroll container, used to decide which
 *  top/bottom fade gradients to show. `none` = not scrollable (or no overflow). */
export type ColumnScrollState = "top" | "middle" | "bottom" | "none";

interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Pure derivation of the scroll-fade state from a scroll container's geometry.
 *  Mirrors the former inline logic in BoardColumn.updateScrollState: a 2px slack
 *  at each end so sub-pixel rounding doesn't flicker the gradients, and a 4px
 *  threshold below which the content isn't considered scrollable at all. */
export function computeColumnScrollState({ scrollTop, scrollHeight, clientHeight }: ScrollGeometry): ColumnScrollState {
  const atTop = scrollTop <= 2;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
  if (scrollHeight <= clientHeight + 4) return "none";
  if (atTop && !atBottom) return "top";
  if (atBottom && !atTop) return "bottom";
  return "middle";
}
