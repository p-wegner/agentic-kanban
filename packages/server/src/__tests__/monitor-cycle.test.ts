import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db/index.js";
import { processWorkspaceCandidates, type ProcessWorkspaceDeps, type WorkspaceCandidate } from "../startup/monitor-cycle.js";

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
});
