// Pure responsive-tab-overflow arithmetic for BoardToolbar's view switcher.
// Extracted from the useLayoutEffect's recompute closure so the greedy-fit logic
// is table-testable; the component keeps the DOM measurement + setVisibleViewCount.

import type { ViewDescriptor, ViewMode } from "./viewRegistry.js";

export interface TabFitInput {
  availableWidth: number;
  tabWidths: number[];
  moreWidth: number;
  /** gap-1 between tabs. */
  gap?: number;
  /** border + padding + small safety margin. */
  overhead?: number;
}

/**
 * How many primary tabs fit in `availableWidth`: if all tabs fit without a "More"
 * trigger, all of them; otherwise reserve room for More + a gap and greedily count
 * tabs that fit the remaining budget (stop at the first that overflows).
 */
export function computeVisibleTabCount({
  availableWidth,
  tabWidths,
  moreWidth,
  gap = 4,
  overhead = 8,
}: TabFitInput): number {
  const totalAll = tabWidths.reduce((sum, w) => sum + w + gap, 0);
  if (totalAll + overhead <= availableWidth) {
    return tabWidths.length;
  }
  let budget = availableWidth - overhead - (moreWidth + gap);
  let count = 0;
  for (const w of tabWidths) {
    if (budget - (w + gap) < 0) break;
    budget -= w + gap;
    count++;
  }
  return count;
}

export interface ToolbarViewSplit {
  visiblePrimaryViews: ViewDescriptor[];
  overflowPrimaryViews: ViewDescriptor[];
  moreViews: ViewDescriptor[];
  activeMoreView: ViewDescriptor | undefined;
}

/** Split the primary views at `visibleCount`; the overflow + secondary views form the "More" menu. */
export function splitToolbarViews(
  primaryViews: ViewDescriptor[],
  secondaryViews: ViewDescriptor[],
  visibleCount: number,
  viewMode: ViewMode,
): ToolbarViewSplit {
  const visiblePrimaryViews = primaryViews.slice(0, visibleCount);
  const overflowPrimaryViews = primaryViews.slice(visibleCount);
  const moreViews = [...overflowPrimaryViews, ...secondaryViews];
  const activeMoreView = moreViews.find((v) => v.id === viewMode);
  return { visiblePrimaryViews, overflowPrimaryViews, moreViews, activeMoreView };
}
