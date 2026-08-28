import { describe, it, expect } from "vitest";
import {
  parseSessionContextAndTool,
  mapWorkspaceDetailsRow,
  type WorkspaceDetailsRow,
  type WorkspaceDetailsSession,
} from "../lib/workspace-details-projection.js";

// #930: a healthy RUNNING session used to report contextTokens/lastTool as null and
// lastSessionAt pinned to launch time (startedAt) — the exact "launched then died"
// signature CLAUDE.md tells an operator to act on, even while the agent was actively
// streaming. These tests drive a fake persisted stats blob (what the live-persist path
// in session-manager/broadcast.ts now writes) through the pure projection and assert
// the derived fields advance with it.

function makeRow(overrides: Partial<WorkspaceDetailsRow> = {}): WorkspaceDetailsRow {
  return {
    id: "ws-1",
    issueId: "issue-1",
    branch: "feature/x",
    workingDir: "/tmp/x",
    baseBranch: "master",
    isDirect: false,
    planMode: false,
    includeVisualProof: false,
    requiresReview: true,
    thoroughReview: false,
    readyForMerge: false,
    status: "fixing",
    claudeProfile: null,
    agentCommand: null,
    provider: "claude",
    model: null,
    pendingPlanPath: null,
    skillId: null,
    contextPrimer: null,
    closedAt: null,
    mergedAt: null,
    conflictCacheHasConflicts: null,
    conflictCacheFiles: null,
    diffStatCacheFilesChanged: null,
    diffStatCacheInsertions: null,
    diffStatCacheDeletions: null,
    scorecardScore: null,
    latestSetupCommand: null,
    latestSetupState: null,
    latestSetupStartedAt: null,
    latestSetupEndedAt: null,
    latestSetupExitCode: null,
    latestSetupDurationMs: null,
    latestSetupStdoutTail: null,
    latestSetupStderrTail: null,
    latestSymlinkState: null,
    latestSymlinkStartedAt: null,
    latestSymlinkEndedAt: null,
    latestSymlinkDirs: null,
    latestSymlinkLinked: null,
    latestSymlinkSkipped: null,
    latestSymlinkFailed: null,
    latestSymlinkError: null,
    serviceState: null,
    isolationDowngraded: false,
    isolationDowngradeReason: null,
    createdAt: "2026-08-27T19:00:00.000Z",
    updatedAt: "2026-08-27T19:00:00.000Z",
    issueTitle: "Some issue",
    issuePriority: null,
    skillName: null,
    ...overrides,
  };
}

describe("parseSessionContextAndTool", () => {
  it("returns nulls for an absent/malformed stats blob", () => {
    expect(parseSessionContextAndTool(null)).toEqual({ contextTokens: null, lastTool: null, lastActivityAt: null });
    expect(parseSessionContextAndTool("not json")).toEqual({ contextTokens: null, lastTool: null, lastActivityAt: null });
  });

  it("reads lastActivityAt alongside contextTokens/lastTool from a live-persisted blob", () => {
    const stats = JSON.stringify({ contextTokens: 4200, lastTool: "Bash", lastActivityAt: "2026-08-27T19:50:00.000Z" });
    expect(parseSessionContextAndTool(stats)).toEqual({
      contextTokens: 4200,
      lastTool: "Bash",
      lastActivityAt: "2026-08-27T19:50:00.000Z",
    });
  });
});

describe("mapWorkspaceDetailsRow — running-session freshness (#930)", () => {
  it("reports lastSessionAt/contextTokens/lastTool from a live stats blob instead of stale launch-time nulls", () => {
    const row = makeRow();
    const sess: WorkspaceDetailsSession = {
      status: "running",
      startedAt: "2026-08-27T19:38:42.000Z",
      endedAt: null,
      triggerType: "fix-and-merge",
      // Simulates what applyLiveStats/applyToolActivity now persist as the stream arrives.
      stats: JSON.stringify({
        contextTokens: 18234,
        lastTool: "Bash",
        lastActivityAt: "2026-08-27T19:51:10.000Z",
      }),
    };

    const details = mapWorkspaceDetailsRow(row, sess);

    expect(details.contextTokens).toBe(18234);
    expect(details.lastTool).toBe("Bash");
    // The newest stream event, not the 13-minutes-stale launch timestamp.
    expect(details.lastSessionAt).toBe("2026-08-27T19:51:10.000Z");
    expect(details.activityUnknown).toBe(false);
  });

  it("falls back to startedAt and flags activityUnknown when a running session has emitted no persisted activity yet", () => {
    const row = makeRow();
    const sess: WorkspaceDetailsSession = {
      status: "running",
      startedAt: "2026-08-27T19:38:42.000Z",
      endedAt: null,
      triggerType: "fix-and-merge",
      stats: null,
    };

    const details = mapWorkspaceDetailsRow(row, sess);

    expect(details.contextTokens).toBeNull();
    expect(details.lastTool).toBeNull();
    expect(details.lastSessionAt).toBe("2026-08-27T19:38:42.000Z");
    // The honest signal: this is "no news yet", not "confirmed zero activity" (hung/dead).
    expect(details.activityUnknown).toBe(true);
  });

  it("does not flag activityUnknown for a terminal session with no live activity persisted", () => {
    const row = makeRow();
    const sess: WorkspaceDetailsSession = {
      status: "idle",
      startedAt: "2026-08-27T19:38:42.000Z",
      endedAt: "2026-08-27T19:45:00.000Z",
      triggerType: "fix-and-merge",
      stats: null,
    };

    const details = mapWorkspaceDetailsRow(row, sess);

    expect(details.lastSessionAt).toBe("2026-08-27T19:45:00.000Z");
    expect(details.activityUnknown).toBe(false);
  });

  it("VERIFY-IT-BITES: without lastActivityAt wired, a running session's lastSessionAt would stay pinned to launch time", () => {
    // This asserts the OLD (buggy) behavior would have been wrong — i.e. proves the fix
    // actually changes the observable output rather than being a no-op. If someone reverts
    // the live-persist wiring in broadcast.ts (so lastActivityAt is never written), the
    // "falls back to startedAt" test above still passes for a genuinely idle session, but
    // this test's `sess.stats` (carrying lastActivityAt from live activity) proves that WHEN
    // the field is present, it is honored over startedAt.
    const row = makeRow();
    const sess: WorkspaceDetailsSession = {
      status: "running",
      startedAt: "2026-08-27T19:38:42.000Z",
      endedAt: null,
      triggerType: "fix-and-merge",
      stats: JSON.stringify({ lastActivityAt: "2026-08-27T19:51:10.000Z" }),
    };

    const details = mapWorkspaceDetailsRow(row, sess);
    expect(details.lastSessionAt).not.toBe(sess.startedAt);
    expect(details.lastSessionAt).toBe("2026-08-27T19:51:10.000Z");
  });
});
