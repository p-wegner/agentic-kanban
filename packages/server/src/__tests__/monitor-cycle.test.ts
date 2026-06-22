import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../services/butler-event-feed.js", () => ({
  emitButlerSystemEvent: vi.fn(),
}));

vi.mock("@agentic-kanban/shared/lib/workflow-engine", () => ({
  syncCurrentNodeToStatus: vi.fn(),
}));

import { db } from "../db/index.js";
import {
  MAX_MONITOR_MERGES_PER_CYCLE,
  MAX_MONITOR_RELAUNCHES_PER_CYCLE,
  processWorkspaceCandidates,
  type ProcessWorkspaceDeps,
  type WorkspaceCandidate,
} from "../startup/monitor-cycle.js";

// Returns a chainable drizzle-style select builder that resolves to `result`.
function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "orderBy", "innerJoin"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  for (const fn of ["set", "where"]) {
    chain[fn] = () => chain;
  }
  chain.catch = () => Promise.resolve();
  return chain;
}

// Fake of the injected workspace-actions PORT. Each method resolves by default
// (the success path); a test that wants a failure uses
// `vi.mocked(deps.workspaceActions.merge).mockRejectedValueOnce(...)`. Because the
// monitor now calls these directly instead of self-HTTP, the suite asserts on the
// port methods rather than on `fetch` URLs — and the fetch stub below is purely a
// regression guard that the monitor never reaches for the network again.
function makeWorkspaceActions() {
  return {
    launch: vi.fn<(id: string) => Promise<void>>(async () => {}),
    merge: vi.fn<(id: string) => Promise<void>>(async () => {}),
    fixAndMerge: vi.fn<(id: string, mergeError: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(id: string) => Promise<void>>(async () => {}),
  };
}

function makeDeps(): ProcessWorkspaceDeps {
  return {
    sessionManager: { isProcessAlive: vi.fn(() => true), stopSession: vi.fn() } as unknown as ProcessWorkspaceDeps["sessionManager"],
    boardEvents: { broadcast: vi.fn() } as unknown as ProcessWorkspaceDeps["boardEvents"],
    workspaceActions: makeWorkspaceActions(),
    autoMergeEnabled: true,
    autoMergeInReview: false,
    reviewSessionIds: new Set<string>(),
    monitorRecentActions: [],
    logMonitorAction: vi.fn(),
    buildMonitorNudgePrompt: vi.fn().mockResolvedValue("nudge"),
    getRecentAgentExcerpts: vi.fn().mockResolvedValue([]),
    shouldSkipNudge: vi.fn().mockReturnValue(false),
  };
}

/** Asserts the monitor took NO workspace mutation for this candidate. */
function expectNoWorkspaceAction(deps: ProcessWorkspaceDeps) {
  expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
  expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalled();
  expect(vi.mocked(deps.workspaceActions.fixAndMerge)).not.toHaveBeenCalled();
  expect(vi.mocked(deps.workspaceActions.delete)).not.toHaveBeenCalled();
}

const baseCandidate: WorkspaceCandidate = {
  wsId: "ws-1",
  wsStatus: "idle",
  workingDir: "/path/to/dir",
  isDirect: false,
  projectId: "proj-1",
  issueId: "issue-1",
  issueTitle: "Test Issue",
  issueNumber: 42,
  issueStatusName: "In Review",
  baseBranch: "main",
  readyForMerge: true,
};

beforeEach(() => {
  vi.mocked(db.select)
    .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)          // sessions query → no session
    .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>); // session count → 0
  vi.mocked(db.update).mockReturnValue(makeUpdateChain() as ReturnType<typeof db.update>);
  // The monitor must NEVER call its own server over HTTP — it uses the injected
  // workspaceActions port. This stub turns any regression into a hard failure.
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("monitor-cycle must not self-HTTP — use the injected workspaceActions port");
  }));
});

describe("processWorkspaceCandidates — idle + readyForMerge", () => {
  it("merges (not relaunches) an idle workspace when readyForMerge=true", async () => {
    const deps = makeDeps();
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1");
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action, wsId, issueId]) => action === "merge" && wsId === "ws-1" && issueId === "issue-1")).toBe(true);
  });

  it("calls fix-and-merge when the merge fails (conflict)", async () => {
    const deps = makeDeps();
    vi.mocked(deps.workspaceActions.merge).mockRejectedValueOnce(new Error("Merge conflicts detected"));

    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1");
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).toHaveBeenCalledWith("ws-1", "Merge conflicts detected");
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
  });

  it("calls fix-and-merge when the merge rejects with a network-like error", async () => {
    const deps = makeDeps();
    vi.mocked(deps.workspaceActions.merge).mockRejectedValueOnce(new Error("network error"));

    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).toHaveBeenCalledWith("ws-1", "network error");
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
  });
});

describe("processWorkspaceCandidates — stuck builder recovery", () => {
  it("stops a long-running builder with zero commits and dirty worktree, commits leftovers, and launches review", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{
        id: "sess-1",
        status: "running",
        startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        triggerType: "agent",
        stats: null,
      }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "status-in-review" }]) as ReturnType<typeof db.select>);

    const reviewSessionIds = new Set<string>();
    const deps = {
      ...makeDeps(),
      reviewSessionIds,
      stuckBuilderTimeoutMs: 8 * 60 * 1000,
      getCommitCountAhead: vi.fn().mockResolvedValue(0),
      getWorkingTreeDiff: vi.fn().mockResolvedValue(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,4 @@
-old
+new
+more
+complete work
`),
      commitLeftoverChanges: vi.fn().mockResolvedValue(2),
      startReview: vi.fn().mockResolvedValue({ sessionId: "review-1" }),
    } satisfies ProcessWorkspaceDeps;
    const candidate: WorkspaceCandidate = {
      ...baseCandidate,
      wsStatus: "active",
      readyForMerge: false,
      issueStatusName: "In Progress",
    };

    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats).toEqual({ relaunched: 0, merged: 0, nudged: 0 });
    expect(deps.sessionManager.stopSession).toHaveBeenCalledWith("sess-1");
    expect(deps.getCommitCountAhead).toHaveBeenCalledWith("/path/to/dir", "main");
    expect(deps.commitLeftoverChanges).toHaveBeenCalledWith("/path/to/dir");
    expect(deps.startReview).toHaveBeenCalledWith(db, expect.any(Function), deps.boardEvents, reviewSessionIds, "ws-1", false);
    expect(deps.buildMonitorNudgePrompt).not.toHaveBeenCalled();
    expectNoWorkspaceAction(deps);
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action, wsId, issueId, extra]) =>
      action === "mark_idle"
      && wsId === "ws-1"
      && issueId === "issue-1"
      && extra?.verificationResult === "ok",
    )).toBe(true);
  });
});

describe("processWorkspaceCandidates — idle + readyForMerge=false", () => {
  it("does not relaunch when idle and issue is In Review (no readyForMerge)", async () => {
    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("relaunches when idle and issue is NOT In Review and readyForMerge=false", async () => {
    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false, issueStatusName: "In Progress" };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.relaunched).toBe(1);
    expect(stats.merged).toBe(0);
    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("ws-1");
  });

  it("does not relaunch an idle workspace whose latest session hit a Codex usage limit", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{
        id: "sess-rate-limited",
        status: "stopped",
        startedAt: new Date().toISOString(),
        triggerType: "agent",
        stats: JSON.stringify({
          rateLimited: true,
          rateLimitKind: "codex-usage-limit",
          retryAfter: "Jun 6th, 2026 12:30 AM",
        }),
      }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);

    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false, issueStatusName: "In Progress" };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.relaunched).toBe(0);
    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
  });

  it("restarts an idle workspace that likely came from a stalled fix-and-merge session", async () => {
    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false, issueStatusName: "In Progress" };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats).toEqual({ relaunched: 1, merged: 0, nudged: 0 });
    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("ws-1");
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalled();
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action, wsId, issueId]) => action === "relaunch" && wsId === "ws-1" && issueId === "issue-1")).toBe(true);
  });

  it("caps idle workspace relaunches per monitor cycle", async () => {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < 3; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }

    const deps = makeDeps();
    const candidates = [1, 2, 3].map((n) => ({
      ...baseCandidate,
      wsId: `ws-${n}`,
      issueId: `issue-${n}`,
      readyForMerge: false,
      issueStatusName: "In Progress",
    }));
    const stats = await processWorkspaceCandidates(candidates, deps);

    expect(stats.relaunched).toBe(MAX_MONITOR_RELAUNCHES_PER_CYCLE);
    const launchedIds = vi.mocked(deps.workspaceActions.launch).mock.calls.map(([id]) => id);
    expect(launchedIds).toHaveLength(MAX_MONITOR_RELAUNCHES_PER_CYCLE);
    expect(launchedIds).not.toContain("ws-3");
  });
});

describe("processWorkspaceCandidates — auto_merge_in_review (not-ready In Review)", () => {
  it("does NOT merge or relaunch a zero-diff In-Review workspace awaiting attention", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = {
      ...baseCandidate,
      readyForMerge: false,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: 0,
      diffStatCacheDeletions: 0,
    };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expectNoWorkspaceAction(deps);
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });

  it("still repairs a zero-diff reviewing ghost workspace with no workingDir", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "status-in-progress" }]) as ReturnType<typeof db.select>);

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = {
      ...baseCandidate,
      wsStatus: "reviewing",
      workingDir: null,
      readyForMerge: false,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: 0,
      diffStatCacheDeletions: 0,
    };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expect(vi.mocked(deps.workspaceActions.delete)).toHaveBeenCalledWith("ws-1");
    const logCalls2 = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls2.some(([, action, wsId, issueId]) => action === "mark_idle" && wsId === "ws-1" && issueId === "issue-1")).toBe(true);
  });

  it("merges an idle In-Review workspace with readyForMerge=false when auto_merge_in_review is on", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1");
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
    const logCalls3 = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls3.some(([, action, wsId, issueId]) => action === "merge" && wsId === "ws-1" && issueId === "issue-1")).toBe(true);
  });

  it("falls back to fix-and-merge on conflict when auto_merge_in_review is on", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    vi.mocked(deps.workspaceActions.merge).mockRejectedValueOnce(new Error("Merge conflicts detected"));
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).toHaveBeenCalledWith("ws-1", "Merge conflicts detected");
  });

  it("does NOT merge a not-ready In-Review workspace when auto_merge_in_review is off", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: false };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("does NOT merge a not-ready In-Review workspace when the auto_merge kill-switch is off, even if auto_merge_in_review is on", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: false, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });
});

describe("processWorkspaceCandidates — auto_merge gating", () => {
  it("does NOT merge an idle+readyForMerge workspace when autoMergeEnabled=false", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: false };
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    // No merge, fix-and-merge, or launch should be triggered — workspace is left as-is.
    expectNoWorkspaceAction(deps);
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });

  it("merges an idle+readyForMerge workspace when autoMergeEnabled=true", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1");
  });

  it("caps automatic merges per monitor cycle", async () => {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < 3; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const candidates = [1, 2, 3].map((n) => ({
      ...baseCandidate,
      wsId: `ws-${n}`,
      issueId: `issue-${n}`,
      readyForMerge: true,
    }));
    const stats = await processWorkspaceCandidates(candidates, deps);

    expect(stats.merged).toBe(MAX_MONITOR_MERGES_PER_CYCLE);
    const mergedIds = vi.mocked(deps.workspaceActions.merge).mock.calls.map(([id]) => id);
    expect(mergedIds).toHaveLength(MAX_MONITOR_MERGES_PER_CYCLE);
    expect(mergedIds).not.toContain("ws-3");
  });

  it("does NOT merge a reviewing+stopped workspace when autoMergeEnabled=false", async () => {
    // Override the default session mock: this path needs a stopped session.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);

    const deps = { ...makeDeps(), autoMergeEnabled: false };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("merges a reviewing+stopped workspace when autoMergeEnabled=true", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1");
    // The reviewing+stopped path must never fall back to fix-and-merge.
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).not.toHaveBeenCalled();
  });
});

describe("processWorkspaceCandidates — per-project auto_merge_disabled", () => {
  it("does NOT merge an idle+readyForMerge workspace when its project is in autoMergeDisabledProjectIds", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeDisabledProjectIds: new Set(["proj-1"]) };
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("still merges an idle+readyForMerge workspace from a DIFFERENT project when one project is disabled", async () => {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < 2; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeDisabledProjectIds: new Set(["proj-disabled"]) };
    const disabledCandidate: WorkspaceCandidate = { ...baseCandidate, wsId: "ws-disabled", issueId: "issue-disabled", projectId: "proj-disabled" };
    const enabledCandidate: WorkspaceCandidate = { ...baseCandidate, wsId: "ws-enabled", issueId: "issue-enabled", projectId: "proj-1" };
    const stats = await processWorkspaceCandidates([disabledCandidate, enabledCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-enabled");
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalledWith("ws-disabled");
  });

  it("does NOT merge a reviewing+stopped workspace when its project is in autoMergeDisabledProjectIds", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeDisabledProjectIds: new Set(["proj-1"]) };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("does NOT merge an idle In-Review workspace via auto_merge_in_review when its project is disabled", async () => {
    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true, autoMergeDisabledProjectIds: new Set(["proj-1"]) };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });
});
