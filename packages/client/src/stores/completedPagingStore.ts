// #1541: paging state for the Completed grid. BoardPage owns the fetch (it merges the extra
// Done/Cancelled pages into `archiveColumns`); the grid, several components down, only needs to
// know whether more remain and how to ask — so it reads this slice instead of a 5-file prop drill.
import { create } from "zustand";

interface CompletedPagingState {
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  set: (next: { hasMore: boolean; loading: boolean; loadMore: () => void }) => void;
}

export const useCompletedPagingStore = create<CompletedPagingState>((set) => ({
  hasMore: false,
  loading: false,
  loadMore: () => {},
  set: (next) => set(next),
}));
