import { beforeEach, describe, expect, it } from "vitest";
import { boardFilterActions, useBoardFilterStore } from "./boardFilterStore.js";

// Node test environment: no localStorage/sessionStorage — the store's
// persistence helpers are guarded, so actions still work (state-only).

function resetStore() {
  useBoardFilterStore.setState({
    searchQuery: "",
    focusMode: false,
    statusFilterId: null,
    milestoneFilterId: null,
    createdDateFilter: null,
    showBlocked: false,
    showStaleOnly: false,
    activeTagIds: new Set<string>(),
    issueTypeFilter: null,
    priorityFilter: null,
    filterProjectId: null,
  });
}

describe("boardFilterStore", () => {
  beforeEach(resetStore);

  it("sets and clears the search query", () => {
    useBoardFilterStore.getState().setSearchQuery("auth bug");
    expect(useBoardFilterStore.getState().searchQuery).toBe("auth bug");
    useBoardFilterStore.getState().setSearchQuery("");
    expect(useBoardFilterStore.getState().searchQuery).toBe("");
  });

  it("toggles focus mode", () => {
    expect(useBoardFilterStore.getState().focusMode).toBe(false);
    useBoardFilterStore.getState().toggleFocusMode();
    expect(useBoardFilterStore.getState().focusMode).toBe(true);
    useBoardFilterStore.getState().setFocusMode(false);
    expect(useBoardFilterStore.getState().focusMode).toBe(false);
  });

  it("sets simple filters (status, milestone, created-date, blocked, stale)", () => {
    const s = useBoardFilterStore.getState();
    s.setStatusFilterId("st-1");
    s.setMilestoneFilterId("ms-1");
    s.setCreatedDateFilter("2026-07-01");
    s.toggleShowBlocked();
    s.toggleShowStaleOnly();
    const next = useBoardFilterStore.getState();
    expect(next.statusFilterId).toBe("st-1");
    expect(next.milestoneFilterId).toBe("ms-1");
    expect(next.createdDateFilter).toBe("2026-07-01");
    expect(next.showBlocked).toBe(true);
    expect(next.showStaleOnly).toBe(true);
    useBoardFilterStore.getState().toggleShowBlocked();
    expect(useBoardFilterStore.getState().showBlocked).toBe(false);
  });

  it("toggles tag filters immutably and clears them", () => {
    const before = useBoardFilterStore.getState().activeTagIds;
    useBoardFilterStore.getState().toggleTagFilter("tag-a");
    useBoardFilterStore.getState().toggleTagFilter("tag-b");
    const after = useBoardFilterStore.getState().activeTagIds;
    expect(after).not.toBe(before); // new Set identity per change
    expect([...after].sort()).toEqual(["tag-a", "tag-b"]);
    useBoardFilterStore.getState().toggleTagFilter("tag-a");
    expect([...useBoardFilterStore.getState().activeTagIds]).toEqual(["tag-b"]);
    useBoardFilterStore.getState().clearTagFilter();
    expect(useBoardFilterStore.getState().activeTagIds.size).toBe(0);
  });

  it("replaces the tag filter wholesale via setTagFilterIds", () => {
    useBoardFilterStore.getState().toggleTagFilter("old");
    useBoardFilterStore.getState().setTagFilterIds(["x", "y"]);
    expect([...useBoardFilterStore.getState().activeTagIds].sort()).toEqual(["x", "y"]);
  });

  it("prunes invalid tag ids without touching other filters", () => {
    useBoardFilterStore.getState().setTagFilterIds(["keep", "gone"]);
    useBoardFilterStore.getState().setIssueTypeFilter("bug");
    useBoardFilterStore.getState().pruneTagFilter(new Set(["keep"]));
    expect([...useBoardFilterStore.getState().activeTagIds]).toEqual(["keep"]);
    expect(useBoardFilterStore.getState().issueTypeFilter).toBe("bug");
  });

  it("applies a saved board view state (tags + type + priority)", () => {
    useBoardFilterStore.getState().applyBoardViewState({
      tagIds: ["t1"],
      tagNames: ["one"],
      issueType: "feature",
      priority: "high",
    });
    const s = useBoardFilterStore.getState();
    expect([...s.activeTagIds]).toEqual(["t1"]);
    expect(s.issueTypeFilter).toBe("feature");
    expect(s.priorityFilter).toBe("high");
  });

  it("hydrateProjectFilters resets per-project filters when storage is empty", () => {
    useBoardFilterStore.getState().setTagFilterIds(["stale"]);
    useBoardFilterStore.getState().setIssueTypeFilter("bug");
    useBoardFilterStore.getState().hydrateProjectFilters("project-2");
    const s = useBoardFilterStore.getState();
    expect(s.filterProjectId).toBe("project-2");
    expect(s.activeTagIds.size).toBe(0);
    expect(s.issueTypeFilter).toBeNull();
    expect(s.priorityFilter).toBeNull();
  });

  it("exposes non-reactive actions via boardFilterActions", () => {
    boardFilterActions.setSearchQuery("q");
    boardFilterActions.setMilestoneFilterId("m1");
    boardFilterActions.setCreatedDateFilter("2026-01-01");
    boardFilterActions.toggleFocusMode();
    const s = useBoardFilterStore.getState();
    expect(s.searchQuery).toBe("q");
    expect(s.milestoneFilterId).toBe("m1");
    expect(s.createdDateFilter).toBe("2026-01-01");
    expect(s.focusMode).toBe(true);
  });
});
