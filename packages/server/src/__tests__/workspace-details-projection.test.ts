import { describe, it, expect } from "vitest";
import {
  parseJsonArray,
  parseSessionContextAndTool,
  mapWorkspaceDetailsRow,
  type WorkspaceDetailsRow,
  type WorkspaceDetailsSession,
} from "../lib/workspace-details-projection.js";

describe("parseJsonArray", () => {
  it("returns fallback for null/malformed/non-array", () => {
    expect(parseJsonArray(null, [])).toEqual([]);
    expect(parseJsonArray("{bad", ["x"])).toEqual(["x"]);
    expect(parseJsonArray('{"a":1}', [])).toEqual([]);
  });
  it("parses a JSON array", () => {
    expect(parseJsonArray<string>('["a","b"]', [])).toEqual(["a", "b"]);
  });
});

describe("parseSessionContextAndTool", () => {
  it("returns nulls for null/malformed stats", () => {
    expect(parseSessionContextAndTool(null)).toEqual({ contextTokens: null, lastTool: null });
    expect(parseSessionContextAndTool("{bad")).toEqual({ contextTokens: null, lastTool: null });
  });
  it("prefers explicit contextTokens, else input+cacheRead", () => {
    expect(parseSessionContextAndTool(JSON.stringify({ contextTokens: 999 })).contextTokens).toBe(999);
    expect(parseSessionContextAndTool(JSON.stringify({ inputTokens: 100, cacheReadTokens: 50 })).contextTokens).toBe(150);
  });
  it("returns null contextTokens when all zero", () => {
    expect(parseSessionContextAndTool(JSON.stringify({ inputTokens: 0 })).contextTokens).toBeNull();
  });
  it("extracts a non-empty string lastTool", () => {
    expect(parseSessionContextAndTool(JSON.stringify({ lastTool: "Edit" })).lastTool).toBe("Edit");
    expect(parseSessionContextAndTool(JSON.stringify({ lastTool: "" })).lastTool).toBeNull();
  });
});

function baseRow(over: Partial<WorkspaceDetailsRow> = {}): WorkspaceDetailsRow {
  return {
    id: "w1", issueId: "i1", branch: "feature/x", workingDir: "/wd", baseBranch: "main",
    isDirect: false, planMode: false, includeVisualProof: false, requiresReview: true,
    thoroughReview: false, readyForMerge: false, status: "idle", claudeProfile: "anth",
    agentCommand: null, provider: "claude", model: null, pendingPlanPath: null, skillId: null,
    contextPrimer: null, closedAt: null, mergedAt: null,
    conflictCacheHasConflicts: null, conflictCacheFiles: null,
    diffStatCacheFilesChanged: null, diffStatCacheInsertions: null, diffStatCacheDeletions: null,
    scorecardScore: null,
    latestSetupCommand: null, latestSetupState: null, latestSetupStartedAt: null, latestSetupEndedAt: null,
    latestSetupExitCode: null, latestSetupDurationMs: null, latestSetupStdoutTail: null, latestSetupStderrTail: null,
    latestSymlinkState: null, latestSymlinkStartedAt: null, latestSymlinkEndedAt: null, latestSymlinkDirs: null,
    latestSymlinkLinked: null, latestSymlinkSkipped: null, latestSymlinkFailed: null, latestSymlinkError: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    issueTitle: "Title", issuePriority: "high", skillName: null,
    serviceState: null, isolationDowngraded: false, isolationDowngradeReason: null,
    ...over,
  };
}

describe("mapWorkspaceDetailsRow", () => {
  it("maps nullable caches to null when absent", () => {
    const out = mapWorkspaceDetailsRow(baseRow(), null);
    expect(out.conflicts).toBeNull();
    expect(out.diffStats).toBeNull();
    expect(out.scorecard).toBeNull();
    expect(out.latestSetup).toBeNull();
    expect(out.latestSymlink).toBeNull();
    expect(out.lastSessionAt).toBeNull();
    expect(out.issue).toEqual({ title: "Title", priority: "high" });
  });

  it("maps conflicts/diffStats/scorecard when present", () => {
    const out = mapWorkspaceDetailsRow(
      baseRow({
        conflictCacheHasConflicts: true, conflictCacheFiles: '["a.ts"]',
        diffStatCacheFilesChanged: 3, diffStatCacheInsertions: 10, diffStatCacheDeletions: 2,
        scorecardScore: 88,
      }),
      null,
    );
    expect(out.conflicts).toEqual({ hasConflicts: true, conflictingFiles: ["a.ts"] });
    expect(out.diffStats).toEqual({ filesChanged: 3, insertions: 10, deletions: 2 });
    expect(out.scorecard).toEqual({ score: 88 });
  });

  it("keeps an all-zero diffStats cache (informational, not dropped)", () => {
    const out = mapWorkspaceDetailsRow(baseRow({ diffStatCacheFilesChanged: 0 }), null);
    expect(out.diffStats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("uses startedAt for running sessions and endedAt otherwise", () => {
    const running: WorkspaceDetailsSession = { status: "running", startedAt: "S", endedAt: "E", triggerType: "user", stats: null };
    expect(mapWorkspaceDetailsRow(baseRow(), running).lastSessionAt).toBe("S");
    const stopped: WorkspaceDetailsSession = { ...running, status: "stopped" };
    expect(mapWorkspaceDetailsRow(baseRow(), stopped).lastSessionAt).toBe("E");
  });

  it("threads session context tokens and last tool from stats", () => {
    const sess: WorkspaceDetailsSession = {
      status: "stopped", startedAt: "S", endedAt: "E", triggerType: null,
      stats: JSON.stringify({ contextTokens: 1234, lastTool: "Bash" }),
    };
    const out = mapWorkspaceDetailsRow(baseRow(), sess);
    expect(out.contextTokens).toBe(1234);
    expect(out.lastTool).toBe("Bash");
  });

  // #321 — a plugin-loop workspace's skill is a DISK skill with no agent_skills row, so the
  // skillId join is null and the card's skill chip used to disappear. The session's trigger type
  // is the only record of it.
  it("names a disk skill from the session trigger when the skillId join is empty", () => {
    const sess: WorkspaceDetailsSession = {
      status: "stopped", startedAt: "S", endedAt: "E", triggerType: "skill:pm-step-runner", stats: null,
    };
    expect(mapWorkspaceDetailsRow(baseRow(), sess).skillName).toBe("pm-step-runner");
  });

  it("prefers the joined DB skill over the session trigger, and ignores non-skill triggers", () => {
    const sess: WorkspaceDetailsSession = {
      status: "stopped", startedAt: "S", endedAt: "E", triggerType: "skill:pm-step-runner", stats: null,
    };
    expect(mapWorkspaceDetailsRow(baseRow({ skillName: "code-review" }), sess).skillName).toBe("code-review");
    expect(mapWorkspaceDetailsRow(baseRow(), { ...sess, triggerType: "review" }).skillName).toBeNull();
    expect(mapWorkspaceDetailsRow(baseRow(), { ...sess, triggerType: "skill:" }).skillName).toBeNull();
    expect(mapWorkspaceDetailsRow(baseRow(), null).skillName).toBeNull();
  });

  it("maps a latest symlink run", () => {
    const out = mapWorkspaceDetailsRow(baseRow({ latestSymlinkState: "linked", latestSymlinkDirs: '["node_modules"]' }), null);
    expect(out.latestSymlink?.state).toBe("linked");
    expect(out.latestSymlink?.dirs).toEqual(["node_modules"]);
  });
});
