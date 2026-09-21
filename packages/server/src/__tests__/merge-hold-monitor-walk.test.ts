/**
 * #1164 — the monitor walk (`canStartMerge` in `monitor-cycle.ts`) must skip a workspace that is
 * on merge hold, without touching its per-project relaunch/merge caps. Same doubles as
 * `monitor-cycle.test.ts`'s "idle + readyForMerge" suite, which this mirrors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: { select: vi.fn(), update: vi.fn() },
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
import {
  processWorkspaceCandidates,
  type ProcessWorkspaceDeps,
  type WorkspaceCandidate,
} from "../startup/monitor-cycle.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "orderBy", "innerJoin"]) chain[fn] = () => chain;
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain as unknown as ReturnType<typeof db.select>;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  for (const fn of ["set", "where"]) chain[fn] = () => chain;
  chain.catch = () => Promise.resolve();
  return chain as unknown as ReturnType<typeof db.update>;
}

function makeWorkspaceActions() {
  return {
    launch: vi.fn<(id: string) => Promise<void>>(async () => {}),
    merge: vi.fn<(id: string) => Promise<void>>(async () => {}),
    fixAndMerge: vi.fn<(id: string, mergeError: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(id: string) => Promise<void>>(async () => {}),
    updateBase: vi.fn<(id: string, mode: "rebase" | "merge") => Promise<void>>(async () => {}),
  };
}

function makeDeps(heldWorkspaceIds: Set<string>): ProcessWorkspaceDeps {
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
    heldWorkspaceIds,
  };
}

const candidate: WorkspaceCandidate = {
  wsId: "ws-held-candidate",
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
  mergeGateRanAt: new Date().toISOString(),
  mergeGateStage: "verify",
  mergeGateSource: "review-exit gate",
};

beforeEach(() => {
  vi.mocked(db.select)
    .mockReturnValueOnce(makeSelectChain([]))
    .mockReturnValueOnce(makeSelectChain([{ count: 0 }]));
  vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
  vi.mocked(db.update).mockReturnValue(makeUpdateChain());
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("monitor-cycle must not self-HTTP — use the injected workspaceActions port");
  }));
});

describe("processWorkspaceCandidates honors a merge hold (#1164)", () => {
  it("merges an idle+readyForMerge workspace normally when it is NOT held", async () => {
    const deps = makeDeps(new Set());
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(1);
    expect(vi.mocked(deps.workspaceActions.merge)).toHaveBeenCalledWith("ws-held-candidate", expect.anything());
  });

  it("skips an idle+readyForMerge workspace that IS held — no merge, no relaunch, no cap consumed", async () => {
    const deps = makeDeps(new Set(["ws-held-candidate"]));
    const stats = await processWorkspaceCandidates([candidate], deps);

    expect(stats.merged).toBe(0);
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();
  });

  it("resumes being eligible once the hold is released (an unheld set merges normally)", async () => {
    const held = new Set(["ws-held-candidate"]);
    const heldDeps = makeDeps(held);
    await processWorkspaceCandidates([candidate], heldDeps);
    expect(vi.mocked(heldDeps.workspaceActions.merge)).not.toHaveBeenCalled();

    // "Release" = the next cycle reads a hold set that no longer contains this workspace —
    // exactly what `getHeldWorkspaceIds()` would return after `clearMergeHold`.
    const releasedDeps = makeDeps(new Set());
    const stats = await processWorkspaceCandidates([candidate], releasedDeps);
    expect(stats.merged).toBe(1);
    expect(vi.mocked(releasedDeps.workspaceActions.merge)).toHaveBeenCalledWith("ws-held-candidate", expect.anything());
  });
});
