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

/** A fade gradient means "there is more content in this direction", so each one is shown
 *  only where content is actually scrolled out of view that way. These live here rather
 *  than inline in BoardColumn because the inline predicates were inverted (#940): the top
 *  fade was tied to `"top"` — a column's RESTING state — so a 24px gradient permanently
 *  covered the upper part of the first ticket card. */
export function showsTopFade(state: ColumnScrollState): boolean {
  return state === "middle" || state === "bottom";
}

export function showsBottomFade(state: ColumnScrollState): boolean {
  return state === "top" || state === "middle";
}
