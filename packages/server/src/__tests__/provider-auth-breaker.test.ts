// @covers agents.authFailure.breaker [recovery, boundary]
//
// #430 steps 2 and 3. Step 1 landed the classification; this is what acts on it.
//
// MEASURED: a `mealplan` workspace burned 10 sessions in 91 seconds, all on the SAME profile, all
// dying with `Failed to authenticate: OAuth session expired and could not be refreshed`. Rotation
// never fired — the only thing that triggered it was quota exhaustion — and each failure left the
// workspace `idle`, which is the status every automation path reads as "start this". The severity
// was backwards: the self-healing failure (quota) had first-class handling, the one needing a
// human had none.
import { describe, expect, it } from "vitest";
import {
  failureClassOf,
  isProfileBreakerOpen,
  nextFailureRecord,
  PROFILE_BREAKER_THRESHOLD,
  type AgentProfileFailureSummary,
} from "../services/agent-profile-failure-record.js";

const BASE = {
  provider: "claude" as const,
  profileName: "anth",
  at: "2026-08-12T10:00:00.000Z",
};

describe("failure streak counting (#430 step 3)", () => {
  it("counts repeats of the SAME failure", () => {
    let record: AgentProfileFailureSummary | null = null;
    for (let i = 0; i < 3; i++) {
      record = nextFailureRecord(record, { ...BASE, summary: "OAuth session expired and could not be refreshed" });
    }
    expect(record!.consecutive).toBe(3);
  });

  it("does not reset on the volatile parts of the message", () => {
    // The raw summary carries a duration and often a session id; comparing verbatim would restart
    // the streak on every attempt and the threshold would never be reached — which is exactly the
    // 10-failures-in-91-seconds loop.
    const first = nextFailureRecord(null, { ...BASE, summary: "Agent launch failed after 3s (session 41)" });
    const second = nextFailureRecord(first, { ...BASE, summary: "Agent launch failed after 9s (session 42)" });
    expect(second.consecutive).toBe(2);
  });

  it("restarts the streak when the failure changes", () => {
    const first = nextFailureRecord(null, { ...BASE, summary: "OAuth session expired" });
    const different = nextFailureRecord(first, { ...BASE, summary: "spawn claude ENOENT" });
    expect(different.consecutive).toBe(1);
  });

  it("keeps the streak's start time, which the count alone does not give", () => {
    const first = nextFailureRecord(null, { ...BASE, summary: "OAuth session expired" });
    const second = nextFailureRecord(first, { ...BASE, at: "2026-08-12T10:05:00.000Z", summary: "OAuth session expired" });
    expect(second.firstAt).toBe(BASE.at);
    expect(second.at).toBe("2026-08-12T10:05:00.000Z");
  });

  it("normalises digits but keeps the distinguishing words", () => {
    expect(failureClassOf("failed after 3s")).toBe(failureClassOf("failed after 41s"));
    expect(failureClassOf("OAuth session expired")).not.toBe(failureClassOf("spawn ENOENT"));
  });
});

describe("isProfileBreakerOpen (#430 step 3)", () => {
  const withCount = (consecutive: number): AgentProfileFailureSummary => ({
    ...BASE, summary: "OAuth session expired", consecutive,
  });

  it("stays CLOSED on a single failure — one launch failure can be a transient", () => {
    // Declaring a working profile dead is worse than one wasted retry.
    expect(isProfileBreakerOpen(withCount(1))).toBe(false);
  });

  it("stays closed just below the threshold", () => {
    expect(isProfileBreakerOpen(withCount(PROFILE_BREAKER_THRESHOLD - 1))).toBe(false);
  });

  it("opens at the threshold", () => {
    expect(isProfileBreakerOpen(withCount(PROFILE_BREAKER_THRESHOLD))).toBe(true);
  });

  it("is closed when there is no record at all", () => {
    expect(isProfileBreakerOpen(null)).toBe(false);
    expect(isProfileBreakerOpen(undefined)).toBe(false);
  });

  it("is closed for a legacy record with no count", () => {
    // Records written before the counter existed must not read as an open breaker.
    expect(isProfileBreakerOpen({ ...BASE, summary: "old record" })).toBe(false);
  });
});
