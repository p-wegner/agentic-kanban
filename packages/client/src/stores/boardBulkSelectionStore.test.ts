import { beforeEach, describe, expect, it } from "vitest";
import {
  boardBulkSelectionActions,
  useBoardBulkSelectionStore,
} from "./boardBulkSelectionStore.js";

function resetStore() {
  useBoardBulkSelectionStore.setState({
    selectedBoardIssueIds: new Set<string>(),
    lastSelectedBoardIssueId: null,
    boardBulkUpdating: false,
    pendingIssueIds: new Set<string>(),
    pendingWorkspaceIssueIds: new Set<string>(),
  });
}

describe("boardBulkSelectionStore", () => {
  beforeEach(resetStore);

  it("addToSelection adds ids and tracks the range anchor", () => {
    useBoardBulkSelectionStore.getState().addToSelection("a");
    useBoardBulkSelectionStore.getState().addToSelection("b");
    const s = useBoardBulkSelectionStore.getState();
    expect([...s.selectedBoardIssueIds].sort()).toEqual(["a", "b"]);
    expect(s.lastSelectedBoardIssueId).toBe("b");
  });

  it("toggleSelection toggles membership", () => {
    useBoardBulkSelectionStore.getState().toggleSelection("a");
    expect(useBoardBulkSelectionStore.getState().selectedBoardIssueIds.has("a")).toBe(true);
    useBoardBulkSelectionStore.getState().toggleSelection("a");
    expect(useBoardBulkSelectionStore.getState().selectedBoardIssueIds.has("a")).toBe(false);
    expect(useBoardBulkSelectionStore.getState().lastSelectedBoardIssueId).toBe("a");
  });

  it("rangeSelect selects the span between anchor and target in visible order", () => {
    const order = ["i1", "i2", "i3", "i4", "i5"];
    useBoardBulkSelectionStore.getState().toggleSelection("i2"); // anchor
    useBoardBulkSelectionStore.getState().rangeSelect(order, "i4");
    expect([...useBoardBulkSelectionStore.getState().selectedBoardIssueIds].sort()).toEqual([
      "i2", "i3", "i4",
    ]);
  });

  it("rangeSelect works backwards (target before anchor)", () => {
    const order = ["i1", "i2", "i3", "i4"];
    useBoardBulkSelectionStore.getState().toggleSelection("i3"); // anchor
    useBoardBulkSelectionStore.getState().rangeSelect(order, "i1");
    expect([...useBoardBulkSelectionStore.getState().selectedBoardIssueIds].sort()).toEqual([
      "i1", "i2", "i3",
    ]);
  });

  it("rangeSelect without a valid anchor selects only the target", () => {
    useBoardBulkSelectionStore.getState().rangeSelect(["a", "b"], "b");
    expect([...useBoardBulkSelectionStore.getState().selectedBoardIssueIds]).toEqual(["b"]);
  });

  it("clearSelection empties selection and the anchor", () => {
    useBoardBulkSelectionStore.getState().addToSelection("a");
    useBoardBulkSelectionStore.getState().clearSelection();
    const s = useBoardBulkSelectionStore.getState();
    expect(s.selectedBoardIssueIds.size).toBe(0);
    expect(s.lastSelectedBoardIssueId).toBeNull();
  });

  it("setSelectedBoardIssueIds accepts a value or an updater (useState parity)", () => {
    useBoardBulkSelectionStore.getState().setSelectedBoardIssueIds(new Set(["x"]));
    expect(useBoardBulkSelectionStore.getState().selectedBoardIssueIds.has("x")).toBe(true);
    useBoardBulkSelectionStore.getState().setSelectedBoardIssueIds((prev) => {
      const next = new Set(prev);
      next.add("y");
      return next;
    });
    expect([...useBoardBulkSelectionStore.getState().selectedBoardIssueIds].sort()).toEqual(["x", "y"]);
  });

  it("pending sets accept functional updates via the non-reactive actions", () => {
    boardBulkSelectionActions.setPendingIssueIds((prev) => new Set([...prev, "p1"]));
    boardBulkSelectionActions.setPendingWorkspaceIssueIds((prev) => new Set([...prev, "w1"]));
    let s = useBoardBulkSelectionStore.getState();
    expect(s.pendingIssueIds.has("p1")).toBe(true);
    expect(s.pendingWorkspaceIssueIds.has("w1")).toBe(true);
    boardBulkSelectionActions.setPendingWorkspaceIssueIds((prev) => {
      const next = new Set(prev);
      next.delete("w1");
      return next;
    });
    s = useBoardBulkSelectionStore.getState();
    expect(s.pendingWorkspaceIssueIds.size).toBe(0);
  });

  it("tracks boardBulkUpdating", () => {
    useBoardBulkSelectionStore.getState().setBoardBulkUpdating(true);
    expect(useBoardBulkSelectionStore.getState().boardBulkUpdating).toBe(true);
    useBoardBulkSelectionStore.getState().setBoardBulkUpdating(false);
    expect(useBoardBulkSelectionStore.getState().boardBulkUpdating).toBe(false);
  });
});
