import { describe, expect, it } from "vitest";
import {
  boardViewStatesEqual,
  deleteSavedBoardView,
  renameSavedBoardView,
  resolveBoardViewState,
  sanitizeSavedBoardViews,
  upsertSavedBoardView,
  type BoardViewState,
  type SavedBoardView,
} from "./boardSavedViews.js";

const baseState: BoardViewState = {
  tagIds: ["tag-visual", "tag-review"],
  tagNames: ["visual-verification", "review"],
  issueType: "feature",
  priority: "high",
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

  it("applies saved views and remaps tag references by name", () => {
    const resolved = resolveBoardViewState(
      savedView({
        state: {
          ...baseState,
          tagIds: ["deleted-tag"],
        },
      }).state,
      [
        { id: "tag-visual-new", name: "visual-verification" },
        { id: "tag-review-new", name: "review" },
      ],
    );

    expect(resolved.dropped).toEqual([]);
    expect(resolved.state.tagIds).toEqual(["tag-visual-new", "tag-review-new"]);
  });

  it("drops stale tag filters when neither id nor name exists", () => {
    const resolved = resolveBoardViewState(baseState, []);

    expect(resolved.dropped).toEqual(["tag"]);
    expect(resolved.state.tagIds).toEqual([]);
  });

  it("keeps valid tags and reports partial stale tag filters", () => {
    const resolved = resolveBoardViewState(baseState, [
      { id: "tag-visual", name: "visual-verification" },
    ]);

    expect(resolved.dropped).toEqual(["tag"]);
    expect(resolved.state.tagIds).toEqual(["tag-visual"]);
    expect(resolved.state.tagNames).toEqual(["visual-verification"]);
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
    expect(parsed[0].state.priority).toBe("high");
  });

  it("matches saved view state independent of tag order", () => {
    expect(boardViewStatesEqual(baseState, {
      tagIds: ["tag-review", "tag-visual"],
      tagNames: [],
      issueType: "feature",
      priority: "high",
    })).toBe(true);
  });
});
