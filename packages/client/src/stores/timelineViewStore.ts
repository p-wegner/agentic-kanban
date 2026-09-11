// Persisted per-view Timeline viewport + filter state (#1090, #1088 batch-2
// follow-up), so switching to another board view and back does not reset the
// anchor/zoom or the type/completed filters.
//
// Scale itself is NOT stored here — it is the URL tab (lib/viewTabs.ts
// TIMELINE_TABS), and useViewTab already publishes it to viewTabStore. This
// store only holds what a URL segment cannot: the pan position, zoom level,
// and the toolbar's own filter toggles.
//
// `byView` is keyed by the CALLER-BUILT key, not bare view id: an anchor is a
// position in one project's issue-date range, so TimelineView keys by
// `${projectId}:${viewId}` — otherwise switching projects while on this view
// would restore a stale anchor from a different project's data range.
import { create } from "zustand";
import type { Scale } from "../lib/timeScale.js";

export interface TimelineFilterState {
  /** `Viewport.anchor` — left edge of the visible window, ms epoch (local time). */
  anchor: number;
  /** `Viewport.pxPerMs` — zoom level. */
  pxPerMs: number;
  /**
   * The scale `anchor`/`pxPerMs` were computed for, so a restore can tell whether the
   * CURRENT scale (the URL tab, resolved independently — see TimelineView) still matches
   * what this zoom density means. Optional only for entries written before this field
   * existed; a missing value is treated as "assume it already matches" rather than forcing
   * a reconciliation with no basis for one.
   */
  scale?: Scale;
  showCompleted: boolean;
  /** `Set<string>` is not itself persistable across renders as a plain value; store the array. */
  activeTypes: string[];
  /**
   * Priority/tag filters (P2-15 remainder, #1100). Optional — entries persisted before these
   * fields existed have neither, which reads as "no filter" (an empty array), same as an
   * explicit empty selection.
   */
  activePriorities?: string[];
  activeTagIds?: string[];
}

interface TimelineViewStoreState {
  byView: Partial<Record<string, TimelineFilterState>>;
  set: (viewId: string, state: TimelineFilterState) => void;
}

export const useTimelineViewStore = create<TimelineViewStoreState>((set) => ({
  byView: {},
  set: (viewId, state) => set((s) => ({ byView: { ...s.byView, [viewId]: state } })),
}));
