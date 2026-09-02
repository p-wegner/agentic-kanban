/**
 * #1003 — one definition of "launch failure", and it does not read token counts.
 *
 * The workspace Timeline carried a second copy that inferred failure from absent
 * `inputTokens`/`outputTokens`. It called both of #999's sessions — 100 minutes, 132 tool
 * calls, exit 0, `completed` — "Session exited with zero output (launch failure)", while the
 * Launch Failures panel beside it, reading the corrected predicate, called the same sessions
 * healthy.
 */
import { describe, it, expect } from "vitest";
import { isLaunchFailedSession, endedWithinLaunchWindow } from "../services/session-launch-failure.js";

/** The stats blob shape a completed session actually had while #1002's lost-update was live. */
const COMPLETED_WITH_TOKENS_LOST = JSON.stringify({
  launch: { provider: "claude-code", profile: "anth", triggerType: "review" },
  contextTokens: 124_687,
  lastActivityAt: "2026-09-02T10:00:44.258Z",
  lastTool: "PowerShell",
  friction: { totalToolCalls: 20, failedToolCalls: 0, errorCount: 0 },
});

describe("isLaunchFailedSession", () => {
  it("does not call a completed session a failure just because its token counts are missing", () => {
    expect(isLaunchFailedSession({ stats: COMPLETED_WITH_TOKENS_LOST })).toBe(false);
  });

  it("does not call a session a failure for reporting zero tokens", () => {
    expect(isLaunchFailedSession({ stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }) })).toBe(false);
  });

  it("trusts the lifecycle's explicit stamp", () => {
    expect(isLaunchFailedSession({ stats: JSON.stringify({ launchFailure: true }) })).toBe(true);
  });

  it("treats a recorded unsuccessful provider result as a failure", () => {
    expect(isLaunchFailedSession({ stats: JSON.stringify({ success: false }) })).toBe(true);
  });

  it("keeps a successful result out of it", () => {
    expect(isLaunchFailedSession({ stats: JSON.stringify({ success: true, inputTokens: 12 }) })).toBe(false);
  });

  it("says nothing about a session with no stats, or unparseable ones", () => {
    expect(isLaunchFailedSession({ stats: null })).toBe(false);
    expect(isLaunchFailedSession({ stats: "{not json" })).toBe(false);
  });
});

describe("endedWithinLaunchWindow", () => {
  it("flags a sub-second exit — a launch that never happened", () => {
    expect(endedWithinLaunchWindow({
      startedAt: "2026-09-02T08:14:25.567Z",
      endedAt: "2026-09-02T08:14:26.100Z",
    })).toBe(true);
  });

  it("leaves a long healthy run alone", () => {
    expect(endedWithinLaunchWindow({
      startedAt: "2026-09-02T08:14:25.567Z",
      endedAt: "2026-09-02T09:54:52.001Z",
    })).toBe(false);
  });

  it("says nothing about a session still running", () => {
    expect(endedWithinLaunchWindow({ startedAt: "2026-09-02T08:14:25.567Z", endedAt: null })).toBe(false);
  });
});
