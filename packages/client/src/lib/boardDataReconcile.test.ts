import { describe, expect, it } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import {
  deriveInactiveIssueIds,
  prunePendingWorkspaceIssueIds,
  pruneRecordKeys,
  reconcileBoardIssueIdentity,
} from "./boardDataReconcile.js";

function issue(id: string, over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id,
    issueNumber: Number(id.replace(/\D/g, "")) || 1,
    title: `Issue ${id}`,
    statusId: "s1",
    statusName: "Todo",
    issueType: "task",
    ...over,
  } as IssueWithStatus;
}

function col(name: string, issues: IssueWithStatus[]): StatusWithIssues {
  return { id: name, name, position: 0, issues } as StatusWithIssues;
}

function withMain(id: string, status: string | undefined): IssueWithStatus {
  return issue(id, {
    workspaceSummary: status === undefined ? undefined : ({ main: { status } } as any),
  } as Partial<IssueWithStatus>);
}

describe("reconcileBoardIssueIdentity", () => {
  it("returns the board untouched on first load (no previous columns)", () => {
    const board = [col("Todo", [issue("1")])];
    expect(reconcileBoardIssueIdentity([], board)).toBe(board);
  });

  it("reuses the previous issue reference when the IssueCard signature is unchanged", () => {
    const prevIssue = issue("1", { title: "Same" });
    const prev = [col("Todo", [prevIssue])];
    const freshIssue = issue("1", { title: "Same" });
    const board = [col("Todo", [freshIssue])];

    const result = reconcileBoardIssueIdentity(prev, board);

    expect(result[0].issues[0]).toBe(prevIssue);
    expect(result[0].issues[0]).not.toBe(freshIssue);
  });

  it("keeps the fresh reference when the issue's card-relevant data changed", () => {
    const prev = [col("Todo", [issue("1", { title: "Old" })])];
    const freshIssue = issue("1", { title: "New" });
    const board = [col("Todo", [freshIssue])];

    const result = reconcileBoardIssueIdentity(prev, board);

    expect(result[0].issues[0]).toBe(freshIssue);
  });

  it("keeps brand-new issues that have no previous counterpart", () => {
    const prev = [col("Todo", [issue("1")])];
    const newIssue = issue("2");
    const board = [col("Todo", [issue("1"), newIssue])];

    const result = reconcileBoardIssueIdentity(prev, board);

    expect(result[0].issues[1]).toBe(newIssue);
  });
});

describe("deriveInactiveIssueIds", () => {
  it("flags issues with no workspace and non-active/fixing statuses", () => {
    const board = [
      col("Todo", [withMain("1", undefined), withMain("2", "closed")]),
      col("In Progress", [withMain("3", "active"), withMain("4", "fixing")]),
    ];

    const inactive = deriveInactiveIssueIds(board);

    expect(inactive).toEqual(new Set(["1", "2"]));
  });
});

describe("prunePendingWorkspaceIssueIds", () => {
  it("returns the same reference when the set is empty", () => {
    const prev = new Set<string>();
    expect(prunePendingWorkspaceIssueIds(prev, [col("Todo", [])])).toBe(prev);
  });

  it("drops ids whose main workspace has materialized (non-closed)", () => {
    const prev = new Set(["1", "2", "3"]);
    const board = [
      col("Todo", [withMain("1", "active"), withMain("2", "closed")]),
      col("Done", [withMain("3", "fixing")]),
    ];

    const result = prunePendingWorkspaceIssueIds(prev, board);

    // 1 and 3 materialized; 2 is closed so it stays pending.
    expect(result).toEqual(new Set(["2"]));
  });

  it("returns the same reference when nothing was pruned", () => {
    const prev = new Set(["9"]);
    const board = [col("Todo", [withMain("1", "active")])];
    expect(prunePendingWorkspaceIssueIds(prev, board)).toBe(prev);
  });
});

describe("pruneRecordKeys", () => {
  it("removes dropped keys and returns a new object", () => {
    const record = { a: 1, b: 2, c: 3 };
    const result = pruneRecordKeys(record, new Set(["a", "c"]));
    expect(result).toEqual({ b: 2 });
    expect(result).not.toBe(record);
  });

  it("returns the same reference when no key was present", () => {
    const record = { a: 1 };
    expect(pruneRecordKeys(record, new Set(["x", "y"]))).toBe(record);
  });
});
