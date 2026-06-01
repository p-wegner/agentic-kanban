import { describe, expect, it } from "vitest";
import {
  deleteSavedBoardView,
  renameSavedBoardView,
  resolveBoardViewState,
  sanitizeSavedBoardViews,
  upsertSavedBoardView,
  type BoardViewState,
  type SavedBoardView,
} from "./boardSavedViews.js";

const baseState: BoardViewState = {
  searchQuery: "review",
  showBlocked: true,
  statusId: "status-review",
  statusName: "In Review",
  tagId: "tag-visual",
  tagName: "visual-verification",
  sortMode: "rank",
  viewMode: "kanban",
};

function savedView(overrides: Partial<SavedBoardView> = {}): SavedBoardView {
  return {
    id: "view-1",
    name: "Review queue",
    state: baseState,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("board saved views", () => {
  it("saves the current board state as a named view", () => {
    const views = upsertSavedBoardView([], "Review queue", baseState, "2026-06-01T01:00:00.000Z");

    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("Review queue");
    expect(views[0].state).toEqual(baseState);
    expect(views[0].createdAt).toBe("2026-06-01T01:00:00.000Z");
  });

  it("applies saved views and remaps status and tag references by name", () => {
    const resolved = resolveBoardViewState(
      savedView({
        state: {
          ...baseState,
          statusId: "deleted-status",
          tagId: "deleted-tag",
        },
      }).state,
      [{ id: "status-review-new", name: "In Review" }],
      [{ id: "tag-visual-new", name: "visual-verification" }],
    );

    expect(resolved.dropped).toEqual([]);
    expect(resolved.state.statusId).toBe("status-review-new");
    expect(resolved.state.tagId).toBe("tag-visual-new");
  });

  it("drops stale status and tag filters when neither id nor name exists", () => {
    const resolved = resolveBoardViewState(baseState, [], []);

    expect(resolved.dropped).toEqual(["status", "tag"]);
    expect(resolved.state.statusId).toBeNull();
    expect(resolved.state.tagId).toBeNull();
  });

  it("renames and deletes saved views", () => {
    const renamed = renameSavedBoardView([savedView()], "view-1", "Blocked work", "2026-06-01T02:00:00.000Z");

    expect(renamed[0].name).toBe("Blocked work");
    expect(renamed[0].updatedAt).toBe("2026-06-01T02:00:00.000Z");
    expect(deleteSavedBoardView(renamed, "view-1")).toEqual([]);
  });

  it("loads persisted saved views from JSON", () => {
    const parsed = sanitizeSavedBoardViews(JSON.stringify([savedView()]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Review queue");
    expect(parsed[0].state.searchQuery).toBe("review");
  });
});
