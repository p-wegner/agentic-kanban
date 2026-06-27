// @covers workspaces.lifecycle.hang-watchdog [error, state-transition]
//
// The board monitor is the watchdog for hung agents: in
// `handleActiveRunningWorkspace` (startup/monitor-cycle.ts), an ACTIVE workspace
// whose latest session is still RUNNING and whose process is alive — but which
// has been running past the 5-minute threshold without exiting — is detected and
// NUDGED (a follow-up turn is sent to unstick it, plus a "nudge" action is
// logged and the board re-broadcast). A session still under that threshold is
// left untouched. This test exercises BOTH sides of that state transition.
//
// Time is injected the project-recommended way: the session's `startedAt` is
// seeded relative to `Date.now()` (never a hardcoded ISO that ages out), so the
// elapsed-time comparison the watchdog makes is deterministic.
//
// The stuck-builder recovery timeout (default 9 min) is overridden to a large
// value so it never fires here — that isolates the assertion to the pure nudge
// (hang) threshold rather than the heavier stop+commit recovery path.

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
  processWorkspaceCandidates,
  type ProcessWorkspaceDeps,
  type WorkspaceCandidate,
} from "../startup/monitor-cycle.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// Chainable drizzle-style select builder that resolves to `result`.
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

function makeWorkspaceActions() {
  return {
    launch: vi.fn<(id: string) => Promise<void>>(async () => {}),
    merge: vi.fn<(id: string) => Promise<void>>(async () => {}),
    fixAndMerge: vi.fn<(id: string, mergeError: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(id: string) => Promise<void>>(async () => {}),
  };
}

// The session manager mock reports the agent process as ALIVE (so the watchdog
// does not take the "dead → mark idle" branch) and records every nudge turn it
// is asked to send.
function makeSessionManager() {
  return {
    isProcessAlive: vi.fn(() => true),
    stopSession: vi.fn(),
    sendTurn: vi.fn((_sessionId: string, _content: string) => ({ ok: true as const })),
  };
}

function makeDeps(sessionManager = makeSessionManager()): ProcessWorkspaceDeps {
  return {
    sessionManager: sessionManager as unknown as ProcessWorkspaceDeps["sessionManager"],
    boardEvents: { broadcast: vi.fn() } as unknown as ProcessWorkspaceDeps["boardEvents"],
    workspaceActions: makeWorkspaceActions(),
    autoMergeEnabled: true,
    autoMergeInReview: false,
    reviewSessionIds: new Set<string>(),
    monitorRecentActions: [],
    logMonitorAction: vi.fn(),
    buildMonitorNudgePrompt: vi.fn().mockResolvedValue("nudge: please continue or wrap up"),
    getRecentAgentExcerpts: vi.fn().mockResolvedValue([]),
    shouldSkipNudge: vi.fn().mockReturnValue(false),
    // Keep the heavier stuck-builder recovery path well out of range so this
    // test isolates the 5-minute hang/nudge threshold.
    stuckBuilderTimeoutMs: 60 * 60 * 1000,
  };
}

// One ACTIVE workspace whose latest session is still RUNNING — the shape that
// reaches handleActiveRunningWorkspace.
const runningCandidate: WorkspaceCandidate = {
  wsId: "ws-1",
  wsStatus: "active",
  workingDir: "/path/to/dir",
  isDirect: false,
  projectId: "proj-1",
  issueId: "issue-1",
  issueTitle: "Long-running task",
  issueNumber: 42,
  issueStatusName: "In Progress",
  baseBranch: "main",
  readyForMerge: false,
};

// db.select is called twice per candidate: latest session, then session count.
function mockRunningSession(startedAt: string) {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select)
    .mockReturnValueOnce(
      makeSelectChain([
        { id: "sess-1", status: "running", startedAt, triggerType: "agent", stats: null },
      ]) as ReturnType<typeof db.select>,
    )
    .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
}

beforeEach(() => {
  vi.mocked(db.update).mockReturnValue(makeUpdateChain() as ReturnType<typeof db.update>);
  // The monitor must never self-HTTP — turn any regression into a hard failure.
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("monitor-cycle must not self-HTTP — use the injected workspaceActions port");
  }));
});

describe("hang watchdog — running agent past the 5-minute threshold", () => {
  it("nudges a live agent whose session has been running longer than 5 minutes", async () => {
    // Provably PAST the threshold: started 6 minutes ago (but under the 1h
    // stuck-builder recovery timeout), seeded relative to now.
    const startedAt = new Date(Date.now() - (FIVE_MINUTES_MS + 60 * 1000)).toISOString();
    mockRunningSession(startedAt);

    const sessionManager = makeSessionManager();
    const deps = makeDeps(sessionManager);
    const stats = await processWorkspaceCandidates([runningCandidate], deps);

    // Observable state transition: the watchdog acted — exactly one nudge.
    expect(stats.nudged).toBe(1);
    // It must NOT have stopped the agent or taken any merge/relaunch action.
    expect(sessionManager.stopSession).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.merge)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.workspaceActions.launch)).not.toHaveBeenCalled();

    // The nudge is delivered as a follow-up turn to the hung session.
    expect(sessionManager.sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionManager.sendTurn).toHaveBeenCalledWith("sess-1", "nudge: please continue or wrap up");

    // And the "nudge" action is logged + the board re-broadcast.
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action, wsId, issueId]) => action === "nudge" && wsId === "ws-1" && issueId === "issue-1")).toBe(true);
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
  });

  it("does NOT nudge a fresh agent whose session is still under the 5-minute threshold", async () => {
    // Provably UNDER the threshold: started 1 minute ago.
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockRunningSession(startedAt);

    const sessionManager = makeSessionManager();
    const deps = makeDeps(sessionManager);
    const stats = await processWorkspaceCandidates([runningCandidate], deps);

    // No watchdog action for a healthy, recently-started agent.
    expect(stats.nudged).toBe(0);
    expect(sessionManager.sendTurn).not.toHaveBeenCalled();
    expect(sessionManager.stopSession).not.toHaveBeenCalled();
    const logCalls = vi.mocked(deps.logMonitorAction).mock.calls;
    expect(logCalls.some(([, action]) => action === "nudge")).toBe(false);
  });
});
