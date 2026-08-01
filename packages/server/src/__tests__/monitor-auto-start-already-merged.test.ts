import { beforeEach, describe, expect, it, vi } from "vitest";

// #190 regression: the monitor's In-Progress backfill and Todo/Backlog pull loops must
// not treat an issue whose workspace already merged (mergedAt set) as unstarted work —
// that spawned a SECOND workspace for the same issue on a live fleetops drive, leaking a
// permanent WIP slot and leaving the issue stuck in a non-terminal status forever.
//
// This suite is deliberately isolated from monitor-auto-start.test.ts: that file's mock
// sequencing predates the #189 fleet-dispatch gate and has unrelated pre-existing
// failures out of this ticket's scope. Here the dispatch gate is mocked away entirely so
// only the already-merged guard under test is exercised.

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("../services/worker-fleet.service.js", () => ({
  projectCanDispatch: vi.fn(async () => ({ available: true })),
}));

const reconcileMergedIssueMock = vi.fn();
vi.mock("../services/merge-cleanup.service.js", () => ({
  reconcileMergedIssue: (...args: unknown[]) => reconcileMergedIssueMock(...args),
}));

import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";
import { openFileContentionGate } from "../startup/monitor-file-contention.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    serverPort: 3001,
    boardEvents: { broadcast: vi.fn() } as unknown as AutoStartDeps["boardEvents"],
    logMonitorAction: vi.fn(),
    allowProject: () => true,
    buildContentionGate: async () => openFileContentionGate(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.stubGlobal("fetch", vi.fn());
  reconcileMergedIssueMock.mockReset();
  reconcileMergedIssueMock.mockResolvedValue({ projectId: "proj-1", issueTransitioned: true, targetStatusId: "done-1" });
});

describe("runAutoStart already-merged guard (#190)", () => {
  it("does NOT spawn a second workspace for an In-Progress issue whose (closed) workspace already merged, and reconciles it to Done instead", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-15", title: "Driver hours-of-service duty logs", description: "", issueType: "feature", issueNumber: 15 }])) // loop1 inProgressIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: "2026-08-01T01:00:42.000Z" }])) // issueWorkspaces: closed + merged
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])); // todoStatus (none) -> loop2 ends

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(reconcileMergedIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-15", projectId: "proj-1" }),
    );
  });

  it("does NOT spawn a workspace for a Todo/Backlog issue whose (closed) workspace already merged", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([])) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }])) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-15", title: "Driver hours-of-service duty logs", description: "", projectId: "proj-1", issueNumber: 15 }])) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }])) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: "2026-08-01T01:00:42.000Z" }])); // issueWorkspaces: closed + merged

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(reconcileMergedIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-15", projectId: "proj-1" }),
    );
  });

  it("still starts an In-Progress issue whose workspace is closed but was never merged (no mergedAt) — not confused with #190", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-20", title: "Something else", description: "", issueType: "bug", issueNumber: 20 }])) // loop1 inProgressIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: null }])) // issueWorkspaces: closed, never merged (e.g. abandoned)
      .mockReturnValueOnce(makeSelectChain([])) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])); // todoStatus (none) -> loop2 ends
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces", expect.any(Object));
    expect(reconcileMergedIssueMock).not.toHaveBeenCalled();
  });

  it("still skips (no launch) an In-Progress issue with a genuinely OPEN workspace, without touching the already-merged reconciler", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 1, inactiveStale: 0 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-21", title: "Being worked", description: "", issueType: "feature", issueNumber: 21 }])) // loop1 inProgressIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "active", mergedAt: null }])) // issueWorkspaces: still active
      .mockReturnValueOnce(makeSelectChain([{ active: 1, inactiveStale: 0 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])); // todoStatus (none) -> loop2 ends

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(reconcileMergedIssueMock).not.toHaveBeenCalled();
  });
});
