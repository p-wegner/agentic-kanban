import { describe, expect, it } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { applyLocalReorder, moveIssueToStatus } from "./issueMoveHelpers.js";

function mkIssue(id: string, statusId: string, sortOrder: number): IssueWithStatus {
  return {
    id,
    issueNumber: 1,
    title: id,
    priority: "medium",
    issueType: "task",
    sortOrder,
    statusId,
    projectId: "p1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    statusName: statusId,
  };
}

function mkColumn(id: string, issues: IssueWithStatus[]): StatusWithIssues {
  return { id, name: id, projectId: "p1", sortOrder: 0, issues, count: issues.length };
}

function mkBoard(): StatusWithIssues[] {
  return [
    mkColumn("todo", [mkIssue("a", "todo", 100), mkIssue("b", "todo", 200)]),
    mkColumn("doing", [mkIssue("c", "doing", 100), mkIssue("d", "doing", 300)]),
    mkColumn("done", []),
  ];
}

const CHANGED_AT = "2026-06-11T00:00:00.000Z";

describe("moveIssueToStatus", () => {
  it("appends with next sortOrder when no sortOrder is given", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[0], board[1], CHANGED_AT);
    const doing = result.find((c) => c.id === "doing")!;
    expect(doing.issues.map((i) => i.id)).toEqual(["c", "d", "a"]);
    expect(doing.issues[2].sortOrder).toBe(400); // max(100, 300) + 100
    expect(result.find((c) => c.id === "todo")!.issues.map((i) => i.id)).toEqual(["b"]);
  });

  it("uses sortOrder 0 for an empty target column when no sortOrder is given", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[0], board[2], CHANGED_AT);
    const done = result.find((c) => c.id === "done")!;
    expect(done.issues.map((i) => i.id)).toEqual(["a"]);
    expect(done.issues[0].sortOrder).toBe(0);
  });

  it("places the issue at the given sortOrder, re-sorted into position", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[0], board[1], CHANGED_AT, 200);
    const doing = result.find((c) => c.id === "doing")!;
    expect(doing.issues.map((i) => i.id)).toEqual(["c", "a", "d"]);
    expect(doing.issues[1].sortOrder).toBe(200);
  });

  it("places the issue first when the given sortOrder is the lowest", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[1], board[1], CHANGED_AT, 50);
    const doing = result.find((c) => c.id === "doing")!;
    expect(doing.issues.map((i) => i.id)).toEqual(["b", "c", "d"]);
  });

  it("updates status fields and timestamps on the moved issue", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[0], board[1], CHANGED_AT);
    const moved = result.find((c) => c.id === "doing")!.issues.find((i) => i.id === "a")!;
    expect(moved.statusId).toBe("doing");
    expect(moved.statusName).toBe("doing");
    expect(moved.updatedAt).toBe(CHANGED_AT);
    expect(moved.statusChangedAt).toBe(CHANGED_AT);
  });

  it("keeps the identity of untouched columns", () => {
    const board = mkBoard();
    const result = moveIssueToStatus(board, board[0].issues[0], board[1], CHANGED_AT);
    expect(result[2]).toBe(board[2]); // "done" untouched
  });

  it("uses the freshest issue object from the columns, not the passed snapshot", () => {
    const board = mkBoard();
    const stale = { ...board[0].issues[0], title: "stale-copy" };
    const result = moveIssueToStatus(board, stale, board[1], CHANGED_AT);
    const moved = result.find((c) => c.id === "doing")!.issues.find((i) => i.id === "a")!;
    expect(moved.title).toBe("a");
  });
});

describe("applyLocalReorder", () => {
  it("reorders within the target column and keeps other columns' identity", () => {
    const board = mkBoard();
    const result = applyLocalReorder(board, "todo", "b", 50);
    expect(result.find((c) => c.id === "todo")!.issues.map((i) => i.id)).toEqual(["b", "a"]);
    expect(result[1]).toBe(board[1]);
    expect(result[2]).toBe(board[2]);
  });
});
