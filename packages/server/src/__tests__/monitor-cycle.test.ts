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
  transitionIssueStatus: vi.fn(async () => {}),
}));

vi.mock("../repositories/workspace-status.repository.js", () => ({
  setWorkspaceStatus: vi.fn(async () => true),
}));

import { db } from "../db/index.js";
import { createMonitorProjectScheduler } from "../startup/monitor-project-scheduler.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { QUOTA_BLOCK_PROBE_FALLBACK_MS, orderCandidatesForWalk } from "../startup/monitor-cycle-rules.js";
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
    updateBase: vi.fn<(id: string, mode: "rebase" | "merge") => Promise<void>>(async () => {}),
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
  // Real gate evidence persisted by exit-workflow at review-exit — the monitor now builds its
  // merge-gate token from THIS, not a fabricated `new Date()` (#182).
  mergeGateRanAt: new Date().toISOString(),
  mergeGateStage: "verify",
  mergeGateSource: "review-exit gate",
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

    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", expect.objectContaining({ kind: "already-passed" }));
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

    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", expect.objectContaining({ kind: "already-passed" }));
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

  // #182 regression: the monitor used to fabricate `ranAt: new Date()` / `stage: "none"` for
  // every idle+readyForMerge merge, so `resolveMergeGate`'s 15-min staleness window could NEVER
  // reject it — a `readyForMerge` set hours ago (or never actually gated) was trusted forever.
  // The monitor now carries the REAL evidence persisted on the workspace through unmodified, so a
  // stale `ranAt` stays stale and `resolveMergeGate` (the downstream owner of the freshness check)
  // can actually reject it and re-run the gate.
  it("passes through the real (stale) persisted ranAt instead of fabricating a fresh one", async () => {
    const deps = makeDeps();
    const staleRanAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min old > 15 min window
    const staleCandidate: WorkspaceCandidate = {
      ...baseCandidate,
      mergeGateRanAt: staleRanAt,
      mergeGateStage: "verify",
    };
    const stats = await processWorkspaceCandidates([staleCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ kind: "already-passed", evidence: expect.objectContaining({ ranAt: staleRanAt }) }),
    );
  });

  it("hands over a run-gate token when the workspace has no persisted gate evidence at all (e.g. manual ready-for-merge)", async () => {
    const deps = makeDeps();
    const noEvidenceCandidate: WorkspaceCandidate = {
      ...baseCandidate,
      mergeGateRanAt: null,
      mergeGateStage: null,
      mergeGateSource: null,
    };
    const stats = await processWorkspaceCandidates([noEvidenceCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", { kind: "run-gate" });
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

    expect(stats).toEqual({ relaunched: 0, merged: 0, nudged: 0, deferredProjectIds: [], completedProjectIds: ["proj-1"], notStartedProjectIds: [] });
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

    expect(stats).toEqual({ relaunched: 1, merged: 0, nudged: 0, deferredProjectIds: [], completedProjectIds: ["proj-1"], notStartedProjectIds: [] });
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
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", expect.objectContaining({ kind: "already-passed" }));
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
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", expect.objectContaining({ kind: "already-passed" }));
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
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", expect.objectContaining({ kind: "already-passed" }));
    // The reviewing+stopped path must never fall back to fix-and-merge.
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).not.toHaveBeenCalled();
  });

  it("pins the gated SHAs into the evidence it mints (#573)", async () => {
    // Sha-less evidence falls back to `evidenceIsValid`'s 15-minute AGE check, and `ranAt`
    // is stamped at gate END — so a builder commit landing during a 20-40 minute monitor
    // gate produced evidence that looked fresh, and the moved tip merged having never been
    // tested. The merge-gate and review-exit paths already pinned; these two monitor paths
    // were the only ones that did not.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    await processWorkspaceCandidates([candidate], deps);

    const [, token] = vi.mocked(deps.workspaceActions.merge).mock.calls[0] as [string, { kind: string; evidence?: Record<string, unknown> }];
    expect(token.kind).toBe("already-passed");
    // The point of the fix: the evidence carries the tips the gate ran against, so a moved
    // tip invalidates it by CONTENT rather than surviving on age.
    expect(token.evidence).toHaveProperty("branchSha");
    expect(token.evidence).toHaveProperty("baseSha");
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
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-enabled", expect.objectContaining({ kind: "already-passed" }));
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalledWith("ws-disabled", expect.anything());
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

// #191: a builder can COMMIT a complete implementation, then go idle with readyForMerge=false —
// silently stuck only because its base branch moved after the branch was cut (a sibling ticket
// merged first). Left undetected this is indistinguishable from an idle-empty workspace and just
// gets relaunched into a no-op. These tests cover detection + the auto-recover/flag split.
describe("processWorkspaceCandidates — idle workspace with committed work on a stale base (#191)", () => {
  const staleBaseCandidate: WorkspaceCandidate = {
    ...baseCandidate,
    readyForMerge: false,
    issueStatusName: "In Progress",
  };

  it("auto-recovers via merge (falling back to fix-and-merge) when the base has moved and there are real commits", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(3),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(deps.getCommitCountAhead).toHaveBeenCalledWith("/path/to/dir", "main");
    expect(deps.countBehindCommits).toHaveBeenCalledWith("/path/to/dir", "HEAD", "main");
    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-1", { kind: "run-gate" });
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
  });

  it("falls back to fix-and-merge when the recovery merge conflicts", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(3),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;
    vi.mocked(deps.workspaceActions.merge).mockRejectedValueOnce(new Error("Merge conflicts detected"));

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.fixAndMerge)).toHaveBeenCalledWith("ws-1", "Merge conflicts detected");
  });

  it("flags instead of auto-recovering when auto_merge is disabled", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: false,
      getCommitCountAhead: vi.fn().mockResolvedValue(3),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expectNoWorkspaceAction(deps);
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action, wsId, issueId, extra]) =>
      action === "mark_idle"
      && wsId === "ws-1"
      && issueId === "issue-1"
      && extra?.verificationResult === "failed",
    )).toBe(true);
  });

  it("flags instead of auto-recovering when the project has auto_merge_disabled", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      autoMergeDisabledProjectIds: new Set(["proj-1"]),
      getCommitCountAhead: vi.fn().mockResolvedValue(3),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(stats.merged).toBe(0);
    expectNoWorkspaceAction(deps);
  });

  it("does NOT treat an idle workspace with no commits ahead as a stale-base recovery case", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(0),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    // Falls through to the ordinary idle+not-ready relaunch path — no merge.
    expect(stats.relaunched).toBe(1);
    expect(stats.merged).toBe(0);
    // #324: 0 commits ahead + base moved (behind > 0) → the relaunch rebases first
    // so the agent sees the current base instead of re-failing on a stale tree.
    expect(vi.mocked(deps.workspaceActions.updateBase)).toHaveBeenCalledWith("ws-1", "rebase");
    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("ws-1");
  });

  it("#324: relaunches WITHOUT update-base when the base has not moved", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(0),
      countBehindCommits: vi.fn().mockResolvedValue(0),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(stats.relaunched).toBe(1);
    expect(vi.mocked(deps.workspaceActions.updateBase)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("ws-1");
  });

  it("#324: a failed update-base still falls through to the plain relaunch", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(0),
      countBehindCommits: vi.fn().mockResolvedValue(2),
    } satisfies ProcessWorkspaceDeps;
    vi.mocked(deps.workspaceActions.updateBase).mockRejectedValueOnce(new Error("rebase conflict"));

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    expect(stats.relaunched).toBe(1);
    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("ws-1");
  });

  it("does NOT treat an idle workspace with commits but a NON-stale (up to date) base as a recovery case", async () => {
    const deps = {
      ...makeDeps(),
      autoMergeEnabled: true,
      getCommitCountAhead: vi.fn().mockResolvedValue(3),
      countBehindCommits: vi.fn().mockResolvedValue(0),
    } satisfies ProcessWorkspaceDeps;

    const stats = await processWorkspaceCandidates([staleBaseCandidate], deps);

    // Falls through to the ordinary idle+not-ready relaunch path.
    expect(stats.relaunched).toBe(1);
    expect(stats.merged).toBe(0);
  });
});

// #208: one stalled/slow project must not starve every other project's auto-start/auto-merge
// pass within a single cycle — a per-project time budget defers its REMAINING candidates to
// the next cycle instead of blocking the walk indefinitely.
describe("processWorkspaceCandidates — per-project time budget (#208)", () => {
  it("defers a project's remaining candidates once its time budget is exceeded, without blocking other projects", async () => {
    vi.mocked(db.select).mockReset();
    // 3 candidates total: 2 in the slow project, 1 in a healthy project. Each candidate
    // consumes 2 db.select calls (sessions + session count).
    for (let i = 0; i < 3; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }

    const deps = makeDeps();
    const slowCandidate1: WorkspaceCandidate = { ...baseCandidate, wsId: "slow-1", issueId: "issue-slow-1", projectId: "proj-slow", readyForMerge: false, issueStatusName: "In Progress" };
    const slowCandidate2: WorkspaceCandidate = { ...baseCandidate, wsId: "slow-2", issueId: "issue-slow-2", projectId: "proj-slow", readyForMerge: false, issueStatusName: "In Progress" };
    const healthyCandidate: WorkspaceCandidate = { ...baseCandidate, wsId: "healthy-1", issueId: "issue-healthy-1", projectId: "proj-healthy", readyForMerge: false, issueStatusName: "In Progress" };

    // Fake clock: the budget expires the instant the slow project's first candidate is done,
    // so its second candidate must be deferred. The healthy project's single candidate never
    // sees an expired deadline (its own budget window starts fresh).
    let calls = 0;
    const now = () => {
      calls++;
      // First deadline check for each project group happens before any candidate runs
      // (calls 1 and, depending on scheduling order, an early call for the other group) —
      // return a small, non-expiring value for those, then jump forward for later checks
      // against the SLOW project so its 2nd candidate is seen as past budget.
      return calls <= 2 ? 0 : 1_000_000;
    };

    const stats = await processWorkspaceCandidates([slowCandidate1, slowCandidate2, healthyCandidate], {
      ...deps,
      projectTimeBudgetMs: 1,
      projectConcurrency: 1,
      now,
    });

    expect(vi.mocked(deps.workspaceActions.launch)).toHaveBeenCalledWith("healthy-1");
    expect(stats.deferredProjectIds).toContain("proj-slow");
    // The slow project's SECOND candidate never launched — only the first (before the budget
    // check tripped) and the healthy project's candidate did.
    const launchedIds = vi.mocked(deps.workspaceActions.launch).mock.calls.map(([id]) => id);
    expect(launchedIds).not.toContain("slow-2");
  });
});

// #416: the per-project budget above bounds ONE project's walk, but with 10 driven projects
// the AGGREGATE still exceeded the monitor interval (measured: processing-candidates 184s of
// a 213s cycle at a 4-min interval) — so cycles ran back-to-back and the loop was starved
// continuously. A GLOBAL cycle deadline stops starting NEW project sub-passes; the projects
// that never started are reported so the cross-cycle scheduler resumes at them next cycle.
describe("processWorkspaceCandidates — global cycle budget with carry-over (#416)", () => {
  function queueSelectsFor(candidateCount: number) {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < candidateCount; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }
  }

  const projectIds = ["proj-a", "proj-b", "proj-c"];
  const candidateFor = (projectId: string): WorkspaceCandidate => ({
    ...baseCandidate,
    wsId: `ws-${projectId}`,
    issueId: `issue-${projectId}`,
    projectId,
    readyForMerge: false,
    issueStatusName: "In Progress",
  });

  /** Fast, deterministic git stubs — the walk's decisions, not real git, are under test. */
  function makeBudgetDeps(extra: Partial<ProcessWorkspaceDeps>): ProcessWorkspaceDeps {
    return {
      ...makeDeps(),
      projectConcurrency: 1,
      getCommitCountAhead: vi.fn(async () => 0),
      countBehindCommits: vi.fn(async () => 0),
      ...extra,
    } satisfies ProcessWorkspaceDeps;
  }

  /**
   * Fake clock: calls 1-3 (first group's cycle-deadline check, its per-project deadline
   * arm, its first candidate check) see t=0; every later call sees the deadline as passed,
   * so the SECOND and THIRD project groups never start.
   */
  function makeExpiringClock() {
    let calls = 0;
    return () => {
      calls++;
      return calls <= 3 ? 0 : 1_000_000;
    };
  }

  it("stops starting NEW project sub-passes past the cycle deadline and reports them as not started", async () => {
    queueSelectsFor(3);
    const deps = makeBudgetDeps({ cycleDeadlineMs: 10, now: makeExpiringClock() });

    const result = await processWorkspaceCandidates(projectIds.map(candidateFor), deps);

    expect(result.completedProjectIds).toEqual(["proj-a"]);
    expect(result.notStartedProjectIds).toEqual(["proj-b", "proj-c"]);
    const launchedIds = vi.mocked(deps.workspaceActions.launch).mock.calls.map(([id]) => id);
    expect(launchedIds).toEqual(["ws-proj-a"]);
  });

  it("without a cycle deadline every project completes (unchanged legacy behavior)", async () => {
    queueSelectsFor(3);
    const deps = makeBudgetDeps({});

    const result = await processWorkspaceCandidates(projectIds.map(candidateFor), deps);

    expect(result.completedProjectIds).toEqual(expect.arrayContaining(projectIds));
    expect(result.notStartedProjectIds).toEqual([]);
  });

  it("a budget-stopped cycle plus the scheduler's carry-over covers ALL projects across 2 cycles", async () => {
    const scheduler = createMonitorProjectScheduler({ now: () => 0 });
    const candidates = projectIds.map(candidateFor);
    const orderByPlan = (toRun: string[]) => {
      const idx = new Map(toRun.map((id, i) => [id, i]));
      return candidates
        .filter((c) => idx.has(c.projectId))
        .sort((a, b) => (idx.get(a.projectId) ?? 0) - (idx.get(b.projectId) ?? 0));
    };

    // Cycle 1: deadline trips after the first sub-pass.
    queueSelectsFor(3);
    const deps1 = makeBudgetDeps({ cycleDeadlineMs: 10, now: makeExpiringClock() });
    const plan1 = scheduler.planCycle(projectIds);
    const result1 = await processWorkspaceCandidates(orderByPlan(plan1.toRun), deps1);
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: result1.completedProjectIds });
    expect(result1.completedProjectIds).toEqual(["proj-a"]);

    // Cycle 2: the plan RESUMES at the cursor (proj-b) instead of restarting at proj-a.
    const plan2 = scheduler.planCycle(projectIds);
    expect(plan2.toRun).toEqual(["proj-b", "proj-c"]);
    expect(plan2.skipped).toEqual(["proj-a"]); // completed, inactive, floor not due — cheap skip

    queueSelectsFor(2);
    const deps2 = makeBudgetDeps({});
    const result2 = await processWorkspaceCandidates(orderByPlan(plan2.toRun), deps2);
    expect(result2.completedProjectIds).toEqual(expect.arrayContaining(["proj-b", "proj-c"]));

    // All projects covered across the two cycles.
    const covered = new Set([...result1.completedProjectIds, ...result2.completedProjectIds]);
    expect(covered).toEqual(new Set(projectIds));
    const launched2 = vi.mocked(deps2.workspaceActions.launch).mock.calls.map(([id]) => id);
    expect(launched2).toEqual(expect.arrayContaining(["ws-proj-b", "ws-proj-c"]));
  });
});

// #208 tail: the per-project budget above is only consulted BETWEEN candidates, so it cannot
// preempt a candidate that is itself stuck inside an unbounded await (a `git` call that never
// returns). That left `processWorkspaceCandidates` pending forever — the cycle's `finally`
// never ran, `cycleRunning` stayed true, and every LATER cycle short-circuited on the
// re-entrancy guard, for every project, until a server restart.
describe("processWorkspaceCandidates — preemptive per-candidate timeout (#208 tail)", () => {
  /** A git call that never returns — the real-world wedge this guards against. */
  const neverReturns = () => new Promise<number>(() => {});

  function queueSelectsFor(candidateCount: number) {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < candidateCount; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }
  }

  const hungCandidate: WorkspaceCandidate = {
    ...baseCandidate,
    wsId: "hung-1",
    issueId: "issue-hung-1",
    projectId: "proj-hung",
    workingDir: "/hung/worktree",
    readyForMerge: false,
    issueStatusName: "In Progress",
  };
  const healthyCandidate: WorkspaceCandidate = {
    ...baseCandidate,
    wsId: "healthy-1",
    issueId: "issue-healthy-1",
    projectId: "proj-healthy",
    workingDir: "/healthy/worktree",
    readyForMerge: false,
    issueStatusName: "In Progress",
  };

  /** Hangs only for the wedged worktree, so the healthy project is unaffected. */
  function makeHangingDeps(): ProcessWorkspaceDeps {
    return {
      ...makeDeps(),
      candidateTimeoutMs: 50,
      projectConcurrency: 1,
      getCommitCountAhead: vi.fn((dir: string) => (dir === "/hung/worktree" ? neverReturns() : Promise.resolve(0))),
    } satisfies ProcessWorkspaceDeps;
  }

  it("completes the cycle even when a candidate's git call never returns, and still processes other projects", async () => {
    queueSelectsFor(2);
    const deps = makeHangingDeps();

    // The assertion IS that this await settles at all — before the fix it never did.
    const stats = await processWorkspaceCandidates([hungCandidate, healthyCandidate], deps);

    expect(stats.deferredProjectIds).toContain("proj-hung");
    const launchedIds = vi.mocked(deps.workspaceActions.launch).mock.calls.map(([id]) => id);
    expect(launchedIds).toContain("healthy-1");
    expect(launchedIds).not.toContain("hung-1");
  });

  it("does not poison LATER cycles — a subsequent pass still runs to completion", async () => {
    queueSelectsFor(2);
    await processWorkspaceCandidates([hungCandidate, healthyCandidate], makeHangingDeps());

    // Second cycle: the first one's abandoned git call is still pending in the background.
    queueSelectsFor(2);
    const secondDeps = makeHangingDeps();
    const stats = await processWorkspaceCandidates([hungCandidate, healthyCandidate], secondDeps);

    expect(stats.deferredProjectIds).toContain("proj-hung");
    expect(vi.mocked(secondDeps.workspaceActions.launch).mock.calls.map(([id]) => id)).toContain("healthy-1");
  });
});

// #387: `blocked` was an absorbing state. A workspace parked there by a provider usage
// limit is waiting on a CLOCK, not on a person, but the cycle logged "skipping automation"
// and did nothing — so its latest session never changed, the stall classifier kept re-reading
// the same immutable usage-limit stats row, and the workspace stayed blocked indefinitely.
// Measured on `eventhub`: 18 workspaces blocked for up to 5 days while the same provider
// profile billed successful sessions in the same project.
describe("processWorkspaceCandidates — blocked on a provider usage limit (#387)", () => {
  const blockedCandidate: WorkspaceCandidate = {
    ...baseCandidate,
    wsId: "ws-blocked",
    wsStatus: "blocked",
    issueStatusName: "In Progress",
    readyForMerge: false,
  };

  // `setWorkspaceStatus` is a file-level mock shared with every earlier test in this suite,
  // and nothing clears it globally — so the "must NOT transition" assertions below would read
  // an earlier test's calls without this.
  beforeEach(() => {
    vi.mocked(setWorkspaceStatus).mockClear();
  });

  function quotaStats(retryAfter: string | null) {
    return JSON.stringify({
      rateLimited: true,
      rateLimitKind: "claude-usage-limit",
      ...(retryAfter === null ? {} : { retryAfter }),
    });
  }

  /** Replaces the default beforeEach queue with one session row for the single candidate. */
  function queueSession(session: Record<string, unknown> | null) {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain(session ? [session] : []) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
  }

  it("returns a blocked workspace to idle once its retryAfter has passed", async () => {
    queueSession({
      id: "sess-1",
      status: "stopped",
      startedAt: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
      triggerType: "agent",
      stats: quotaStats(new Date(Date.now() - 38 * 60 * 60 * 1000).toISOString()),
    });
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).toHaveBeenCalledWith(db, "ws-blocked", "idle");
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
  });

  it("keeps a blocked workspace blocked while its retryAfter is still in the future", async () => {
    queueSession({
      id: "sess-1",
      status: "stopped",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      triggerType: "agent",
      stats: quotaStats(new Date(Date.now() + 90 * 60 * 1000).toISOString()),
    });
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).not.toHaveBeenCalled();
    expectNoWorkspaceAction(deps);
  });

  // A quota death with no parseable reset time must not become the same permanent block by
  // another route: it is honoured for a bounded probe window measured from the death.
  it("releases a quota block with no retryAfter after the fallback probe window", async () => {
    queueSession({
      id: "sess-1",
      status: "stopped",
      startedAt: new Date(Date.now() - (QUOTA_BLOCK_PROBE_FALLBACK_MS + 60_000)).toISOString(),
      triggerType: "agent",
      stats: quotaStats(null),
    });
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).toHaveBeenCalledWith(db, "ws-blocked", "idle");
  });

  it("still honours a no-retryAfter quota block inside the fallback probe window", async () => {
    queueSession({
      id: "sess-1",
      status: "stopped",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      triggerType: "agent",
      stats: quotaStats(null),
    });
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).not.toHaveBeenCalled();
  });

  // `blocked` still means "needs a human" for every other reason — this fix adds ONE
  // clock-driven exception, it does not make `blocked` self-clearing in general.
  it("leaves a workspace blocked for a non-quota reason alone", async () => {
    queueSession({
      id: "sess-1",
      status: "stopped",
      startedAt: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
      triggerType: "agent",
      stats: JSON.stringify({ success: false, failureReason: "verify_failed" }),
    });
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).not.toHaveBeenCalled();
    expectNoWorkspaceAction(deps);
  });

  it("leaves a workspace blocked with NO session rows alone", async () => {
    queueSession(null);
    const deps = makeDeps();

    await processWorkspaceCandidates([blockedCandidate], deps);

    expect(vi.mocked(setWorkspaceStatus)).not.toHaveBeenCalled();
    expectNoWorkspaceAction(deps);
  });
});

// #387 residual: the per-project time budget cut the walk off before the blocked
// candidates were ever reached, so the quota-release transition existed but was starved.
// Measured on `eventhub`: 6-21 candidates deferred EVERY cycle, and two releasable
// workspaces stayed blocked for several cycles purely because of their position.
describe("orderCandidatesForWalk", () => {
  it("puts blocked candidates first, since their decision costs no git", () => {
    const input = [
      { wsId: "a", wsStatus: "idle" },
      { wsId: "b", wsStatus: "blocked" },
      { wsId: "c", wsStatus: "active" },
      { wsId: "d", wsStatus: "blocked" },
    ];
    expect(orderCandidatesForWalk(input).map((c) => c.wsId)).toEqual(["b", "d", "a", "c"]);
  });

  it("is stable within each group and returns the input untouched when nothing is blocked", () => {
    const input = [
      { wsId: "a", wsStatus: "idle" },
      { wsId: "b", wsStatus: "reviewing" },
    ];
    expect(orderCandidatesForWalk(input)).toBe(input);
  });
});
