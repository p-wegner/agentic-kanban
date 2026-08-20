import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { boardQueryKeys } from "./boardQueryKeys.js";
import { createBoardColumnsStore } from "./boardColumnsStore.js";

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

const PID = "project-1";

describe("createBoardColumnsStore — react-query as the single owner of board columns", () => {
  let queryClient: QueryClient;
  let projectId: string | null;

  beforeEach(() => {
    queryClient = new QueryClient();
    projectId = PID;
  });

  function makeStore() {
    return createBoardColumnsStore(queryClient, () => projectId);
  }

  it("setColumns writes straight into the board query cache", () => {
    const { setColumns } = makeStore();
    const cols = [col("Todo", [issue("1")])];

    setColumns(cols);

    expect(queryClient.getQueryData(boardQueryKeys.board(PID))).toBe(cols);
  });

  it("columnsRef.current reads back what setColumns just wrote (synchronous read-after-write)", () => {
    const { setColumns, columnsRef } = makeStore();
    const cols = [col("Todo", [issue("1")])];

    setColumns(cols);

    // The optimistic handlers depend on this: after setColumns(x), a later
    // columnsRef.current read must observe x within the same tick.
    expect(columnsRef.current).toBe(cols);
  });

  it("keeps exactly one copy — the ref, the setter, and the query cache never drift", () => {
    const { setColumns, columnsRef, readColumns } = makeStore();
    const cols = [col("Todo", [issue("1")]), col("Done", [issue("2")])];

    setColumns(cols);

    const fromCache = queryClient.getQueryData<StatusWithIssues[]>(boardQueryKeys.board(PID));
    expect(columnsRef.current).toBe(fromCache);
    expect(readColumns()).toBe(fromCache);
  });

  it("applies a SetStateAction updater against the current cached columns", () => {
    const { setColumns, columnsRef } = makeStore();
    setColumns([col("Todo", [issue("1")])]);

    setColumns((prev) => [...prev, col("Done", [issue("2")])]);

    expect(columnsRef.current.map((c) => c.name)).toEqual(["Todo", "Done"]);
  });

  it("an optimistic write is visible immediately and then reconciled by a server write", () => {
    const { setColumns, columnsRef } = makeStore();
    setColumns([col("Todo", [issue("1", { priority: "low" })])]);

    // Optimistic mutation.
    setColumns((prev) =>
      prev.map((c) => ({ ...c, issues: c.issues.map((i) => ({ ...i, priority: "high" })) })),
    );
    expect(columnsRef.current[0].issues[0].priority).toBe("high");

    // Server reconcile via the same single owner — the authoritative payload
    // (a second issue appeared) replaces the optimistic columns in place.
    const reconciled = [col("Todo", [issue("1", { priority: "high" }), issue("2")])];
    setColumns(reconciled);
    expect(columnsRef.current[0].issues.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("writing through columnsRef.current is equivalent to setColumns (one owner)", () => {
    const { columnsRef } = makeStore();
    const cols = [col("Todo", [issue("1")])];

    columnsRef.current = cols;

    expect(queryClient.getQueryData(boardQueryKeys.board(PID))).toBe(cols);
  });

  it("no-ops without an active project and reads as empty", () => {
    const { setColumns, columnsRef, readColumns } = makeStore();
    projectId = null;

    setColumns([col("Todo", [issue("1")])]);

    expect(readColumns()).toEqual([]);
    expect(columnsRef.current).toEqual([]);
    expect(queryClient.getQueryData(boardQueryKeys.board(PID))).toBeUndefined();
  });
});
