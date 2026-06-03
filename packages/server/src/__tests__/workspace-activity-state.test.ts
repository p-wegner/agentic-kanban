import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceActivityState,
  isFailedLaunchSession,
  workspaceStatusPriority,
  ACTIVE_WORKSPACE_STATUSES,
  type WorkspaceActivityInput,
  type SessionActivityInput,
} from "@agentic-kanban/shared";

const NOW = new Date().toISOString();
const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function makeWs(status: string, overrides: Partial<WorkspaceActivityInput> = {}): WorkspaceActivityInput {
  return { status, ...overrides };
}

function makeSession(overrides: Partial<SessionActivityInput> = {}): SessionActivityInput {
  return {
    status: "stopped",
    startedAt: ONE_HOUR_AGO,
    endedAt: NOW,
    stats: null,
    ...overrides,
  };
}

// ─── isFailedLaunchSession ────────────────────────────────────────────────────

describe("isFailedLaunchSession", () => {
  it("returns false for a running session (no endedAt)", () => {
    expect(isFailedLaunchSession({ status: "running", startedAt: ONE_HOUR_AGO, endedAt: null, stats: null })).toBe(false);
  });

  it("returns true for a session that lasted <=1s", () => {
    const startedAt = new Date(Date.now() - 500).toISOString();
    const endedAt = NOW;
    expect(isFailedLaunchSession({ status: "stopped", startedAt, endedAt, stats: null })).toBe(true);
  });

  it("returns true for zero input+output tokens", () => {
    const stats = JSON.stringify({ inputTokens: 0, outputTokens: 0 });
    expect(isFailedLaunchSession(makeSession({ stats }))).toBe(true);
  });

  it("returns true when stats.launchFailure is true", () => {
    const stats = JSON.stringify({ inputTokens: 100, outputTokens: 50, launchFailure: true });
    expect(isFailedLaunchSession(makeSession({ stats }))).toBe(true);
  });

  it("returns false for a normal session with tokens", () => {
    const stats = JSON.stringify({ inputTokens: 5000, outputTokens: 1200 });
    expect(isFailedLaunchSession(makeSession({ stats }))).toBe(false);
  });

  it("returns false when stats JSON is malformed", () => {
    expect(isFailedLaunchSession(makeSession({ stats: "{bad json" }))).toBe(false);
  });
});

// ─── deriveWorkspaceActivityState ────────────────────────────────────────────

describe("deriveWorkspaceActivityState", () => {
  it("running session (status=active) => active, counts as capacity", () => {
    const result = deriveWorkspaceActivityState(makeWs("active"), null);
    expect(result.state).toBe("active");
    expect(result.countsAsActiveCapacity).toBe(true);
  });

  it("reviewing workspace => active, counts as capacity", () => {
    const result = deriveWorkspaceActivityState(makeWs("reviewing"), null);
    expect(result.state).toBe("active");
    expect(result.countsAsActiveCapacity).toBe(true);
  });

  it("awaiting-plan-approval => active, counts as capacity", () => {
    const result = deriveWorkspaceActivityState(makeWs("awaiting-plan-approval"), null);
    expect(result.state).toBe("active");
    expect(result.countsAsActiveCapacity).toBe(true);
  });

  it("fixing workspace => fixing, counts as capacity", () => {
    const result = deriveWorkspaceActivityState(makeWs("fixing"), null);
    expect(result.state).toBe("fixing");
    expect(result.countsAsActiveCapacity).toBe(true);
  });

  it("idle workspace with normal session => idle, does not count as capacity", () => {
    const session = makeSession({ stats: JSON.stringify({ inputTokens: 5000, outputTokens: 1200 }) });
    const result = deriveWorkspaceActivityState(makeWs("idle"), session);
    expect(result.state).toBe("idle");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("idle workspace, no session => idle", () => {
    const result = deriveWorkspaceActivityState(makeWs("idle"), null);
    expect(result.state).toBe("idle");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("zero-output/1s failed launch => failed", () => {
    const startedAt = new Date(Date.now() - 400).toISOString();
    const session = makeSession({ startedAt, endedAt: NOW });
    const result = deriveWorkspaceActivityState(makeWs("idle"), session);
    expect(result.state).toBe("failed");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("zero-token session => failed", () => {
    const session = makeSession({ stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }) });
    const result = deriveWorkspaceActivityState(makeWs("idle"), session);
    expect(result.state).toBe("failed");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("idle In Review with committed diff => in-review-idle, not counted as idle awaiting", () => {
    const ws = makeWs("idle", { diffStatCacheFilesChanged: 3, diffStatCacheInsertions: 42, diffStatCacheDeletions: 5 });
    const result = deriveWorkspaceActivityState(ws, null, "In Review");
    expect(result.state).toBe("in-review-idle");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("idle In Review with zero diff => plain idle (not in-review-idle)", () => {
    const ws = makeWs("idle", { diffStatCacheFilesChanged: 0, diffStatCacheInsertions: 0, diffStatCacheDeletions: 0 });
    const result = deriveWorkspaceActivityState(ws, null, "In Review");
    expect(result.state).toBe("idle");
  });

  it("idle non-In-Review with diff => plain idle (not in-review-idle)", () => {
    const ws = makeWs("idle", { diffStatCacheFilesChanged: 5 });
    const result = deriveWorkspaceActivityState(ws, null, "In Progress");
    expect(result.state).toBe("idle");
  });

  it("closed without mergedAt => closed", () => {
    const result = deriveWorkspaceActivityState(makeWs("closed"), null);
    expect(result.state).toBe("closed");
    expect(result.countsAsActiveCapacity).toBe(false);
  });

  it("closed with mergedAt => merged", () => {
    const result = deriveWorkspaceActivityState(makeWs("closed", { mergedAt: ONE_HOUR_AGO }), null);
    expect(result.state).toBe("merged");
    expect(result.countsAsActiveCapacity).toBe(false);
  });
});

// ─── workspaceStatusPriority ──────────────────────────────────────────────────

describe("workspaceStatusPriority", () => {
  it("active has the highest priority (lowest number)", () => {
    expect(workspaceStatusPriority("active")).toBeLessThan(workspaceStatusPriority("fixing"));
    expect(workspaceStatusPriority("fixing")).toBeLessThan(workspaceStatusPriority("reviewing"));
    expect(workspaceStatusPriority("reviewing")).toBeLessThan(workspaceStatusPriority("awaiting-plan-approval"));
    expect(workspaceStatusPriority("awaiting-plan-approval")).toBeLessThan(workspaceStatusPriority("idle"));
    expect(workspaceStatusPriority("idle")).toBeLessThan(workspaceStatusPriority("closed"));
  });
});

// ─── ACTIVE_WORKSPACE_STATUSES ────────────────────────────────────────────────

describe("ACTIVE_WORKSPACE_STATUSES", () => {
  it("includes active, fixing, reviewing, awaiting-plan-approval", () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has("active")).toBe(true);
    expect(ACTIVE_WORKSPACE_STATUSES.has("fixing")).toBe(true);
    expect(ACTIVE_WORKSPACE_STATUSES.has("reviewing")).toBe(true);
    expect(ACTIVE_WORKSPACE_STATUSES.has("awaiting-plan-approval")).toBe(true);
  });

  it("excludes idle, closed, error", () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has("idle")).toBe(false);
    expect(ACTIVE_WORKSPACE_STATUSES.has("closed")).toBe(false);
    expect(ACTIVE_WORKSPACE_STATUSES.has("error")).toBe(false);
  });
});
