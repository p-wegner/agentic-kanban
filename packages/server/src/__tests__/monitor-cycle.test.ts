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

function makeDeps(): ProcessWorkspaceDeps {
  return {
    sessionManager: { isProcessAlive: vi.fn(() => true) } as unknown as ProcessWorkspaceDeps["sessionManager"],
    boardEvents: { broadcast: vi.fn() } as unknown as ProcessWorkspaceDeps["boardEvents"],
    serverPort: 3001,
    autoMergeEnabled: true,
    autoMergeInReview: false,
    monitorRecentActions: [],
    logMonitorAction: vi.fn(),
    buildMonitorNudgePrompt: vi.fn().mockResolvedValue("nudge"),
    getRecentAgentExcerpts: vi.fn().mockResolvedValue([]),
    shouldSkipNudge: vi.fn().mockReturnValue(false),
  };
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
  vi.stubGlobal("fetch", vi.fn());
});

describe("processWorkspaceCandidates — idle + readyForMerge", () => {
  it("merges (not relaunches) an idle workspace when readyForMerge=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    const deps = makeDeps();
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/merge"))).toBe(true);
    expect(calls.every(([url]) => !String(url).includes("/launch"))).toBe(true);
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
    expect(vi.mocked(deps.logMonitorAction)).toHaveBeenCalledWith(
      expect.anything(), "merge", "ws-1", "issue-1"
    );
  });

  it("calls fix-and-merge when the merge endpoint returns a non-ok response", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ message: "Merge conflicts detected" }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response); // fix-and-merge call

    const deps = makeDeps();
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/merge"))).toBe(true);
    expect(calls.some(([url]) => String(url).includes("/fix-and-merge"))).toBe(true);
    expect(calls.every(([url]) => !String(url).includes("/launch"))).toBe(true);
  });

  it("calls fix-and-merge when fetch itself rejects (network error)", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("network error"))  // merge fetch throws
      .mockResolvedValueOnce({ ok: true } as Response);   // fix-and-merge call

    const deps = makeDeps();
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/fix-and-merge"))).toBe(true);
    expect(calls.every(([url]) => !String(url).includes("/launch"))).toBe(true);
  });
});

describe("processWorkspaceCandidates — idle + readyForMerge=false", () => {
  it("does not relaunch when idle and issue is In Review (no readyForMerge)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("relaunches when idle and issue is NOT In Review and readyForMerge=false", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = makeDeps();
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false, issueStatusName: "In Progress" };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.relaunched).toBe(1);
    expect(stats.merged).toBe(0);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/launch"))).toBe(true);
  });

  it("caps idle workspace relaunches per monitor cycle", async () => {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < 3; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

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
    const launchCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/launch"));
    expect(launchCalls).toHaveLength(MAX_MONITOR_RELAUNCHES_PER_CYCLE);
    expect(launchCalls.some(([url]) => String(url).includes("/ws-3/"))).toBe(false);
  });
});

describe("processWorkspaceCandidates — auto_merge_in_review (not-ready In Review)", () => {
  it("does NOT merge or relaunch a zero-diff In-Review workspace awaiting attention", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

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
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });

  it("still repairs a zero-diff reviewing ghost workspace with no workingDir", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "status-in-progress" }]) as ReturnType<typeof db.select>);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

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
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining("/api/workspaces/ws-1"), { method: "DELETE" });
    expect(vi.mocked(deps.logMonitorAction)).toHaveBeenCalledWith(expect.anything(), "mark_idle", "ws-1", "issue-1");
  });

  it("merges an idle In-Review workspace with readyForMerge=false when auto_merge_in_review is on", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    expect(stats.relaunched).toBe(0);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/merge"))).toBe(true);
    expect(calls.every(([url]) => !String(url).includes("/launch"))).toBe(true);
    expect(vi.mocked(deps.logMonitorAction)).toHaveBeenCalledWith(expect.anything(), "merge", "ws-1", "issue-1");
  });

  it("falls back to fix-and-merge on conflict when auto_merge_in_review is on", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ message: "Merge conflicts detected" }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/fix-and-merge"))).toBe(true);
  });

  it("does NOT merge a not-ready In-Review workspace when auto_merge_in_review is off", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true, autoMergeInReview: false };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does NOT merge a not-ready In-Review workspace when the auto_merge kill-switch is off, even if auto_merge_in_review is on", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: false, autoMergeInReview: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("processWorkspaceCandidates — auto_merge gating", () => {
  it("does NOT merge an idle+readyForMerge workspace when autoMergeEnabled=false", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: false };
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(0);
    expect(stats.relaunched).toBe(0);
    // No merge, fix-and-merge, or launch should be triggered  workspace is left as-is.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });

  it("merges an idle+readyForMerge workspace when autoMergeEnabled=true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const stats = await processWorkspaceCandidates([baseCandidate], deps);

    expect(stats.merged).toBe(1);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/merge"))).toBe(true);
  });

  it("caps automatic merges per monitor cycle", async () => {
    vi.mocked(db.select).mockReset();
    for (let i = 0; i < 3; i++) {
      vi.mocked(db.select)
        .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
        .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>);
    }
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const candidates = [1, 2, 3].map((n) => ({
      ...baseCandidate,
      wsId: `ws-${n}`,
      issueId: `issue-${n}`,
      readyForMerge: true,
    }));
    const stats = await processWorkspaceCandidates(candidates, deps);

    expect(stats.merged).toBe(MAX_MONITOR_MERGES_PER_CYCLE);
    const mergeCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/merge"));
    expect(mergeCalls).toHaveLength(MAX_MONITOR_MERGES_PER_CYCLE);
    expect(mergeCalls.some(([url]) => String(url).includes("/ws-3/"))).toBe(false);
  });

  it("does NOT merge a reviewing+stopped workspace when autoMergeEnabled=false", async () => {
    // Override the default session mock: this path needs a stopped session.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: false };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("merges a reviewing+stopped workspace when autoMergeEnabled=true", async () => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "sess-1", status: "stopped", startedAt: new Date().toISOString() }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const deps = { ...makeDeps(), autoMergeEnabled: true };
    const candidate: WorkspaceCandidate = { ...baseCandidate, wsStatus: "reviewing", readyForMerge: false };
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/merge"))).toBe(true);
  });
});
