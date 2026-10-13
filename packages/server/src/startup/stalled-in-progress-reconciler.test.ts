import { beforeEach, describe, expect, it } from "vitest";
import {
  decideStalledInProgress,
  REDRIVE_COOLDOWN_MS,
  resetStalledInProgressStateForTests,
  STALLED_GRACE_MS,
  STALLED_MAX_AGE_MS,
} from "./stalled-in-progress-reconciler.js";
import { isHangWatchdogKill } from "./session-exit-classification.js";
import type { StalledInProgressCandidate } from "../repositories/stalled-in-progress.repository.js";

const nowMs = Date.now();
const base = (over: Partial<StalledInProgressCandidate> = {}): StalledInProgressCandidate => ({
  workspaceId: "ws1",
  issueId: "i1",
  projectId: "p1",
  issueNumber: 1437,
  workingDir: "/wt",
  baseBranch: "master",
  planMode: false,
  parentWorkspaceId: null,
  forkStatus: null,
  hasRunningSession: false,
  lastSessionId: "s1",
  lastSessionTriggerType: "agent",
  lastSessionEndedAt: new Date(nowMs - STALLED_GRACE_MS - 1000).toISOString(),
  ...over,
});

describe("decideStalledInProgress (#1439)", () => {
  beforeEach(() => resetStalledInProgressStateForTests());

  it("re-drives an idle builder whose session ended past the grace window", () => {
    expect(decideStalledInProgress(base(), nowMs)).toEqual({ redrive: true });
  });

  it.each([
    ["a running session", { hasRunningSession: true }],
    ["a session that ended moments ago", { lastSessionEndedAt: new Date(nowMs - 1000).toISOString() }],
    ["no ended session", { lastSessionId: null, lastSessionEndedAt: null }],
    ["a review session", { lastSessionTriggerType: "review" }],
    ["a fork child", { forkStatus: "running" }],
    ["plan mode", { planMode: true }],
    ["no worktree", { workingDir: null }],
  ])("leaves %s alone", (_name, over) => {
    expect(decideStalledInProgress(base(over), nowMs).redrive).toBe(false);
  });

  it("treats a watchdog-killed session like any ended builder session", () => {
    expect(isHangWatchdogKill("Agent hang watchdog: no output for 900s - process killed on worker.")).toBe(true);
    expect(isHangWatchdogKill("boom")).toBe(false);
    expect(decideStalledInProgress(base({ lastSessionTriggerType: null }), nowMs).redrive).toBe(true);
  });

  it("leaves an abandoned workspace alone: its last session ended over a day ago", () => {
    const old = base({ lastSessionEndedAt: new Date(nowMs - STALLED_MAX_AGE_MS - 1000).toISOString() });
    expect(decideStalledInProgress(old, nowMs)).toEqual({ redrive: false, reason: "abandoned (session ended over a day ago)" });
  });

  it("exposes a cooldown so a no-op re-drive is not repeated every pass", () => {
    expect(REDRIVE_COOLDOWN_MS).toBeGreaterThan(STALLED_GRACE_MS);
  });
});
