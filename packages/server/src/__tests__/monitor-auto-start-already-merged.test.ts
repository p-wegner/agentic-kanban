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
  // Drizzle's select builder is a deep generic no hand-rolled double can satisfy
  // structurally; this suite only ever calls the chain methods stubbed above.
  return chain as unknown as ReturnType<typeof db.select>;
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
      // mergedAt must be forwarded: it is what makes the reconcile a CATCH-UP instead of an
      // unconditional force-to-Done that re-closes a deliberately reopened ticket every cycle.
      expect.objectContaining({ issueId: "issue-15", projectId: "proj-1", mergedAt: "2026-08-01T01:00:42.000Z" }),
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
      expect.objectContaining({ issueId: "issue-15", projectId: "proj-1", mergedAt: "2026-08-01T01:00:42.000Z" }),
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

    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces?async=1&autoStart=1", expect.any(Object));
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

// #265: a reopen after merge used to be respected but INERT — the monitor left the status
// alone and then skipped the issue forever, so on a monitor-driven project it sat in Todo
// until a human made a workspace by hand. It must now start fresh work instead.
describe("runAutoStart reopen-after-merge restart (#265)", () => {
  beforeEach(() => {
    reconcileMergedIssueMock.mockResolvedValue({
      projectId: "proj-1",
      issueTransitioned: false,
      targetStatusId: "todo-1",
      reopenedAfterMerge: true,
    });
  });

  it("starts a NEW workspace on a fresh branch for an In-Progress issue reopened after its merge", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-15", title: "Driver duty logs", description: "d", issueType: "bug", issueNumber: 15 }])) // inProgressIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: "2026-08-01T01:00:42.000Z" }])) // issueWorkspaces
      .mockReturnValueOnce(makeSelectChain([])) // hasSkipAutoStartTag -> none
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([])) // todoStatus (none)
      .mockReturnValue(makeSelectChain([])); // anything further: empty
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.issueId).toBe("issue-15");
    // A FRESH branch: the merged one already contains the landed work, so reusing it would
    // hand the agent a branch with nothing left to do.
    expect(body.branch).toBe("feature/ak-15-driver-duty-logs-r2");
  });

  it("starts a NEW workspace for a Todo issue reopened after its merge", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([])) // inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }])) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-15", title: "Driver duty logs", description: "d", projectId: "proj-1", issueNumber: 15 }])) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }])) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: "2026-08-01T01:00:42.000Z" }])) // issueWorkspaces
      .mockReturnValueOnce(makeSelectChain([])) // hasSkipAutoStartTag -> none
      .mockReturnValueOnce(makeSelectChain([])) // issueDependencies -> none
      .mockReturnValue(makeSelectChain([])); // anything further: empty
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.branch).toBe("feature/ak-15-driver-duty-logs-r2");
  });

  it("does NOT restart when the merge simply predates a stale status (not a reopen)", async () => {
    // The #190 guard must survive: only a DELIBERATE reopen restarts work.
    reconcileMergedIssueMock.mockResolvedValue({
      projectId: "proj-1", issueTransitioned: true, targetStatusId: "done-1", reopenedAfterMerge: false,
    });
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }]))
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-15", title: "Driver duty logs", description: "d", issueType: "bug", issueNumber: 15 }]))
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: "2026-08-01T01:00:42.000Z" }]))
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValue(makeSelectChain([])); // anything further: empty

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]), makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
