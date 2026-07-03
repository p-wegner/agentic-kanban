// Client board store — filter slice (#958, step 2 of the BoardPage
// decentralisation started by boardSelectionStore/#905).
//
// Before this store, every board filter — search query, focus mode, the
// status/milestone/created-date filters, the Blocked/Stale quick filters, and
// the per-project persisted type/priority/tag filters (formerly the
// useBoardFilters hook) — lived as useState on BoardPage and was prop-drilled
// through BoardPageView into the toolbar, the filter menu, the kanban/backlog
// views and every card underneath. Consumers now subscribe directly via
// selectors and call the actions; BoardPage only reads what it needs to compute
// `filteredColumns`.
//
// Persistence behaviour is preserved 1:1 from the previous setters:
// - focusMode mirrors into sessionStorage ("board-focus-mode")
// - issueType / priority / tag filters persist per project in localStorage and
//   are hydrated when the active project changes (hydrateProjectFilters).
import { create } from "zustand";
import type { BoardViewState } from "../lib/boardSavedViews.js";

function readInitialFocusMode(): boolean {
  try {
    return sessionStorage.getItem("board-focus-mode") === "1";
  } catch {
    return false;
  }
}

const typeKey = (projectId: string) => `board-type-filter-${projectId}`;
const priorityKey = (projectId: string) => `board-priority-filter-${projectId}`;
const tagKey = (projectId: string) => `board-tag-filter-${projectId}`;

function persistValue(key: string, value: string | null) {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

function readValue(key: string): string | null {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

export interface BoardFilterStoreState {
  searchQuery: string;
  focusMode: boolean;
  statusFilterId: string | null;
  milestoneFilterId: string | null;
  createdDateFilter: string | null;
  showBlocked: boolean;
  showStaleOnly: boolean;
  /** Tag/type/priority are persisted per project (hydrated on project switch). */
  activeTagIds: Set<string>;
  issueTypeFilter: string | null;
  priorityFilter: string | null;
  /** Project whose persisted filters are currently hydrated (persistence key). */
  filterProjectId: string | null;

  setSearchQuery: (query: string) => void;
  /** Persists to sessionStorage, mirroring the previous BoardPage setter. */
  setFocusMode: (value: boolean) => void;
  toggleFocusMode: () => void;
  setStatusFilterId: (id: string | null) => void;
  setMilestoneFilterId: (id: string | null) => void;
  setCreatedDateFilter: (dateKey: string | null) => void;
  setShowBlocked: (value: boolean) => void;
  toggleShowBlocked: () => void;
  setShowStaleOnly: (value: boolean) => void;
  toggleShowStaleOnly: () => void;
  setIssueTypeFilter: (type: string | null) => void;
  setPriorityFilter: (priority: string | null) => void;
  toggleTagFilter: (tagId: string) => void;
  clearTagFilter: () => void;
  /** Replace the tag filter wholesale (saved-view apply path). Persists. */
  setTagFilterIds: (tagIds: string[]) => void;
  /** Drop tag ids that no longer exist (validation prune — does NOT persist). */
  pruneTagFilter: (validIds: Set<string>) => void;
  /** Load the persisted per-project filters for `projectId`. */
  hydrateProjectFilters: (projectId: string | null) => void;
  /** Apply a saved board view (tags + type + priority). */
  applyBoardViewState: (state: BoardViewState) => void;
}

export const useBoardFilterStore = create<BoardFilterStoreState>((set, get) => ({
  searchQuery: "",
  focusMode: readInitialFocusMode(),
  statusFilterId: null,
  milestoneFilterId: null,
  createdDateFilter: null,
  showBlocked: false,
  showStaleOnly: false,
  activeTagIds: new Set<string>(),
  issueTypeFilter: null,
  priorityFilter: null,
  filterProjectId: null,

  setSearchQuery: (query) => set({ searchQuery: query }),
  setFocusMode: (value) => {
    try {
      sessionStorage.setItem("board-focus-mode", value ? "1" : "0");
    } catch {
      // ignore
    }
    set({ focusMode: value });
  },
  toggleFocusMode: () => get().setFocusMode(!get().focusMode),
  setStatusFilterId: (id) => set({ statusFilterId: id }),
  setMilestoneFilterId: (id) => set({ milestoneFilterId: id }),
  setCreatedDateFilter: (dateKey) => set({ createdDateFilter: dateKey }),
  setShowBlocked: (value) => set({ showBlocked: value }),
  toggleShowBlocked: () => set((s) => ({ showBlocked: !s.showBlocked })),
  setShowStaleOnly: (value) => set({ showStaleOnly: value }),
  toggleShowStaleOnly: () => set((s) => ({ showStaleOnly: !s.showStaleOnly })),

  setIssueTypeFilter: (type) => {
    const { filterProjectId } = get();
    if (filterProjectId) persistValue(typeKey(filterProjectId), type);
    set({ issueTypeFilter: type });
  },
  setPriorityFilter: (priority) => {
    const { filterProjectId } = get();
    if (filterProjectId) persistValue(priorityKey(filterProjectId), priority);
    set({ priorityFilter: priority });
  },
  toggleTagFilter: (tagId) => {
    const { activeTagIds, filterProjectId } = get();
    const next = new Set(activeTagIds);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    if (filterProjectId) {
      persistValue(tagKey(filterProjectId), next.size > 0 ? [...next].join(",") : null);
    }
    set({ activeTagIds: next });
  },
  clearTagFilter: () => {
    const { filterProjectId } = get();
    if (filterProjectId) persistValue(tagKey(filterProjectId), null);
    set({ activeTagIds: new Set<string>() });
  },
  setTagFilterIds: (tagIds) => {
    const next = new Set(tagIds);
    const { filterProjectId } = get();
    if (filterProjectId) {
      persistValue(tagKey(filterProjectId), next.size > 0 ? [...next].join(",") : null);
    }
    set({ activeTagIds: next });
  },
  pruneTagFilter: (validIds) => set({ activeTagIds: validIds }),

  hydrateProjectFilters: (projectId) => {
    if (!projectId) {
      set({ filterProjectId: null });
      return;
    }
    const storedTags = readValue(tagKey(projectId));
    set({
      filterProjectId: projectId,
      issueTypeFilter: readValue(typeKey(projectId)),
      priorityFilter: readValue(priorityKey(projectId)),
      activeTagIds: storedTags
        ? new Set(storedTags.split(",").filter(Boolean))
        : new Set<string>(),
    });
  },

  applyBoardViewState: (state) => {
    const { setTagFilterIds, setIssueTypeFilter, setPriorityFilter } = get();
    setTagFilterIds(state.tagIds);
    setIssueTypeFilter(state.issueType);
    setPriorityFilter(state.priority);
  },
}));

/**
 * Non-reactive access to the filter actions for use outside React render
 * (event handlers, factory hooks, the keyboard-shortcut listener).
 */
export const boardFilterActions = {
  setSearchQuery: (query: string) => useBoardFilterStore.getState().setSearchQuery(query),
  setFocusMode: (value: boolean) => useBoardFilterStore.getState().setFocusMode(value),
  toggleFocusMode: () => useBoardFilterStore.getState().toggleFocusMode(),
  setCreatedDateFilter: (dateKey: string | null) =>
    useBoardFilterStore.getState().setCreatedDateFilter(dateKey),
  setMilestoneFilterId: (id: string | null) =>
    useBoardFilterStore.getState().setMilestoneFilterId(id),
};
