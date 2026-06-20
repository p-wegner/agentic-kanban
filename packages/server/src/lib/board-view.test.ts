import { describe, it, expect } from "vitest";
import {
  buildBoardColumns,
  type BoardStatusRow,
  type BoardIssueRowBase,
} from "./board-view.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-20T12:00:00Z").getTime();

const STATUSES: BoardStatusRow[] = [
  { id: "backlog", name: "Backlog", projectId: "p1", sortOrder: 0 },
  { id: "inprog", name: "In Progress", projectId: "p1", sortOrder: 1 },
  { id: "review", name: "In Review", projectId: "p1", sortOrder: 2 },
  { id: "done", name: "Done", projectId: "p1", sortOrder: 3 },
];

function issue(over: Partial<BoardIssueRowBase> & { id: string; statusId: string }): BoardIssueRowBase {
  return {
    statusName: null,
    statusChangedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    checklistJson: null,
    ...over,
  };
}

function build(issues: BoardIssueRowBase[], opts?: { now?: number }) {
  return buildBoardColumns({
    statuses: STATUSES,
    visibleStatuses: STATUSES,
    projectIssues: issues,
    workspaceSummaryMap: new Map(),
    blockedMap: new Map(),
    issueTagMap: new Map(),
    now: opts?.now ?? NOW,
    staleDays: 14,
    inProgressStaleDays: 3,
  });
}

describe("buildBoardColumns", () => {
  it("groups issues into their columns with counts", () => {
    const cols = build([
      issue({ id: "a", statusId: "backlog" }),
      issue({ id: "b", statusId: "backlog" }),
      issue({ id: "c", statusId: "inprog" }),
    ]);
    const byId = new Map(cols.map((c) => [c.id, c]));
    expect(byId.get("backlog")!.count).toBe(2);
    expect(byId.get("backlog")!.issues.map((i) => i.id)).toEqual(["a", "b"]);
    expect(byId.get("inprog")!.count).toBe(1);
    expect(byId.get("done")!.count).toBe(0);
  });

  it("emits one column per visible status, preserving order", () => {
    const cols = build([]);
    expect(cols.map((c) => c.id)).toEqual(["backlog", "inprog", "review", "done"]);
  });

  it("flags a backlog issue stale past the threshold", () => {
    const cols = build([
      issue({ id: "old", statusId: "backlog", statusChangedAt: new Date(NOW - 20 * DAY).toISOString() }),
      issue({ id: "fresh", statusId: "backlog", statusChangedAt: new Date(NOW - 2 * DAY).toISOString() }),
    ]);
    const backlog = cols.find((c) => c.id === "backlog")!;
    const old = backlog.issues.find((i) => i.id === "old")! as Record<string, unknown>;
    const fresh = backlog.issues.find((i) => i.id === "fresh")! as Record<string, unknown>;
    expect(old.isStale).toBe(true);
    expect(old.staleDays).toBe(20);
    expect(fresh.isStale).toBeUndefined();
  });

  it("does not flag staleness for non-backlog columns", () => {
    const cols = build([
      issue({ id: "x", statusId: "review", statusChangedAt: new Date(NOW - 90 * DAY).toISOString() }),
    ]);
    const x = cols.find((c) => c.id === "review")!.issues[0] as Record<string, unknown>;
    expect(x.isStale).toBeUndefined();
  });

  it("flags an in-progress column issue as column-stale past the threshold", () => {
    const cols = build([
      issue({ id: "slow", statusId: "inprog", statusChangedAt: new Date(NOW - 5 * DAY).toISOString() }),
      issue({ id: "quick", statusId: "inprog", statusChangedAt: new Date(NOW - 1 * DAY).toISOString() }),
    ]);
    const inprog = cols.find((c) => c.id === "inprog")!;
    const slow = inprog.issues.find((i) => i.id === "slow")! as Record<string, unknown>;
    const quick = inprog.issues.find((i) => i.id === "quick")! as Record<string, unknown>;
    expect(slow.isColumnStale).toBe(true);
    expect(slow.columnAgeDays).toBe(5);
    expect(quick.isColumnStale).toBeUndefined();
    expect(quick.columnAgeDays).toBe(1);
  });

  it("lets a workspace workflow node override a non-terminal issue's column", () => {
    const cols = buildBoardColumns({
      statuses: STATUSES,
      visibleStatuses: STATUSES,
      projectIssues: [issue({ id: "m", statusId: "backlog" })],
      workspaceSummaryMap: new Map([
        ["m", { main: { status: "running", workflow: { currentNodeStatusName: "In Progress" } } }],
      ]),
      blockedMap: new Map(),
      issueTagMap: new Map(),
      now: NOW,
      staleDays: 14,
      inProgressStaleDays: 3,
    });
    expect(cols.find((c) => c.id === "backlog")!.count).toBe(0);
    const moved = cols.find((c) => c.id === "inprog")!.issues[0] as Record<string, unknown>;
    expect(moved.id).toBe("m");
    expect(moved.statusName).toBe("In Progress");
  });

  it("honours a terminal issue status over a stale workflow node", () => {
    const cols = buildBoardColumns({
      statuses: STATUSES,
      visibleStatuses: STATUSES,
      projectIssues: [issue({ id: "d", statusId: "done", statusName: "Done" })],
      workspaceSummaryMap: new Map([
        ["d", { main: { status: "running", workflow: { currentNodeStatusName: "In Progress" } } }],
      ]),
      blockedMap: new Map(),
      issueTagMap: new Map(),
      now: NOW,
      staleDays: 14,
      inProgressStaleDays: 3,
    });
    expect(cols.find((c) => c.id === "done")!.count).toBe(1);
    expect(cols.find((c) => c.id === "inprog")!.count).toBe(0);
  });

  it("caps a terminal column at 50, keeping the most recently changed, but reports the true total", () => {
    const issues = Array.from({ length: 60 }, (_, n) =>
      issue({
        id: `done-${n}`,
        statusId: "done",
        statusChangedAt: new Date(NOW - n * DAY).toISOString(),
      }),
    );
    const done = build(issues).find((c) => c.id === "done")!;
    expect(done.count).toBe(60);
    expect(done.issues).toHaveLength(50);
    // Most-recent first: done-0 kept, done-59 dropped.
    expect(done.issues[0].id).toBe("done-0");
    expect(done.issues.some((i) => i.id === "done-59")).toBe(false);
  });

  it("does not cap a non-terminal column", () => {
    const issues = Array.from({ length: 60 }, (_, n) => issue({ id: `b-${n}`, statusId: "backlog" }));
    const backlog = build(issues).find((c) => c.id === "backlog")!;
    expect(backlog.count).toBe(60);
    expect(backlog.issues).toHaveLength(60);
  });

  it("attaches tags and parses a non-empty checklist, dropping checklistJson", () => {
    const cols = buildBoardColumns({
      statuses: STATUSES,
      visibleStatuses: STATUSES,
      projectIssues: [
        issue({ id: "t", statusId: "backlog", checklistJson: JSON.stringify([{ id: "1", text: "do", completed: false }]) }),
        issue({ id: "u", statusId: "backlog", checklistJson: "not json" }),
      ],
      workspaceSummaryMap: new Map(),
      blockedMap: new Map(),
      issueTagMap: new Map([["t", [{ id: "tag1", name: "bug", color: "#f00" }]]]),
      now: NOW,
      staleDays: 14,
      inProgressStaleDays: 3,
    });
    const backlog = cols.find((c) => c.id === "backlog")!;
    const t = backlog.issues.find((i) => i.id === "t")! as Record<string, unknown>;
    const u = backlog.issues.find((i) => i.id === "u")! as Record<string, unknown>;
    expect("checklistJson" in t).toBe(false);
    expect(t.tags).toEqual([{ id: "tag1", name: "bug", color: "#f00" }]);
    expect(t.checklist).toEqual([{ id: "1", text: "do", completed: false }]);
    expect(u.tags).toEqual([]);
    expect(u.checklist).toBeUndefined();
  });

  it("attaches blocked rollup when present", () => {
    const cols = buildBoardColumns({
      statuses: STATUSES,
      visibleStatuses: STATUSES,
      projectIssues: [issue({ id: "b", statusId: "backlog" })],
      workspaceSummaryMap: new Map(),
      blockedMap: new Map([["b", { isBlocked: true, dependencyCount: 2 }]]),
      issueTagMap: new Map(),
      now: NOW,
      staleDays: 14,
      inProgressStaleDays: 3,
    });
    const b = cols.find((c) => c.id === "backlog")!.issues[0] as Record<string, unknown>;
    expect(b.isBlocked).toBe(true);
    expect(b.dependencyCount).toBe(2);
  });
});
