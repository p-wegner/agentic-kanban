/**
 * #649 — the merge circuit breaker had three holes, found by an adversarial audit.
 *
 * 1. Inside the backoff window, ANY branch tip different from the recorded sha cleared the
 *    block. `git commit --allow-empty` satisfies that, so the breaker was voidable at will
 *    and each reset bought another shot at the fix-and-merge escalation.
 * 2. A gate TIMEOUT classified as `generic` — the failure most likely to repeat under the
 *    same load got the LOWEST barrier of any retryable class.
 * 3. Nothing ever stopped retrying. `MERGE_BACKOFF_WARN_REPEATS` only stops WARNING.
 *
 * These tests pin the three fixes, and the property that ties them together: a real fix
 * must still resume a workspace immediately, even past the ceiling.
 */
import { describe, it, expect, vi } from "vitest";
import {
  classifyMergeFailure,
  nextRetryDelayMs,
  attemptCeilingReached,
  shouldSkipMergeForBackoff,
  MERGE_BACKOFF_BASE_MS,
  MERGE_BACKOFF_TIMEOUT_BASE_MS,
  MERGE_BACKOFF_MAX_ATTEMPTS,
  MERGE_BACKOFF_CAP_MS,
} from "../services/merge-backoff.service.js";

const WS = { wsId: "ws-1", projectId: "proj-1", workingDir: "C:/repo/.worktrees/ak-1", issueNumber: 42 };
const RECORDED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A `database` stand-in whose only job is to answer the backoff state read. */
function dbWith(row: Record<string, unknown> | undefined) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => (row ? [row] : []) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as never;
}

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60 * 60_000).toISOString();

describe("timeout is its own backoff class (#649)", () => {
  it("classifies a gate timeout apart from a generic failure", () => {
    expect(classifyMergeFailure("pre-merge gate failed: verify timed out after 1800s")).toBe("verify_timeout");
    expect(classifyMergeFailure("pre-merge gate failed: 3 tests failed")).toBe("generic");
  });

  it("still classifies a missing tool as infra, even when the message says timeout", () => {
    // Waiting forever for a tool that is not installed is an infra problem, not a slow box.
    expect(
      classifyMergeFailure("pre-merge gate failed: ENOENT gradle distribution not found; timed out"),
    ).toBe("verify_infra_missing");
  });

  it("starts the timeout ramp well above the generic one", () => {
    expect(nextRetryDelayMs("verify_timeout", 1)).toBe(MERGE_BACKOFF_TIMEOUT_BASE_MS);
    expect(nextRetryDelayMs("generic", 1)).toBe(MERGE_BACKOFF_BASE_MS);
    expect(nextRetryDelayMs("verify_timeout", 1)).toBeGreaterThan(nextRetryDelayMs("generic", 1));
  });

  it("is retryable — unlike the human-only classes it does not jump straight to the cap", () => {
    expect(nextRetryDelayMs("verify_timeout", 1)).toBeLessThan(MERGE_BACKOFF_CAP_MS);
    expect(nextRetryDelayMs("main_checkout_dirty", 1)).toBe(MERGE_BACKOFF_CAP_MS);
  });
});

describe("an empty commit no longer voids the breaker (#649)", () => {
  const row = { failures: 3, signature: "generic|abc", branchSha: RECORDED_SHA, verifyHash: null, nextRetryAt: FUTURE };

  it("keeps the block when the tip moved but the tree is identical", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith(row),
      getBranchHeadSha: async () => MOVED_SHA,
      hasSubstantiveChangeSince: async () => false,
    });
    expect(decision.skip).toBe(true);
  });

  it("clears the block when the branch actually gained work", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith(row),
      getBranchHeadSha: async () => MOVED_SHA,
      hasSubstantiveChangeSince: async () => true,
    });
    expect(decision.skip).toBe(false);
    expect(decision.reason).toMatch(/new work/);
  });

  it("treats an undiffable sha as changed — a rebased branch IS a rewritten branch", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith(row),
      getBranchHeadSha: async () => MOVED_SHA,
      hasSubstantiveChangeSince: async () => null,
    });
    expect(decision.skip).toBe(false);
  });

  it("does not probe for substance at all when the tip has not moved", async () => {
    const probe = vi.fn(async () => true);
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith(row),
      getBranchHeadSha: async () => RECORDED_SHA,
      hasSubstantiveChangeSince: probe,
    });
    expect(decision.skip).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("the retry ceiling (#649)", () => {
  it("counts from the configured maximum", () => {
    expect(attemptCeilingReached(MERGE_BACKOFF_MAX_ATTEMPTS - 1)).toBe(false);
    expect(attemptCeilingReached(MERGE_BACKOFF_MAX_ATTEMPTS)).toBe(true);
    expect(attemptCeilingReached(null)).toBe(false);
  });

  it("keeps skipping after the window expires, which it never used to", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith({
        failures: MERGE_BACKOFF_MAX_ATTEMPTS,
        signature: "generic|abc",
        branchSha: RECORDED_SHA,
        verifyHash: null,
        nextRetryAt: PAST,
      }),
      getBranchHeadSha: async () => RECORDED_SHA,
    });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toMatch(/exhausted/);
  });

  it("below the ceiling, an expired window still allows the retry", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith({
        failures: MERGE_BACKOFF_MAX_ATTEMPTS - 1,
        signature: "generic|abc",
        branchSha: RECORDED_SHA,
        verifyHash: null,
        nextRetryAt: PAST,
      }),
      getBranchHeadSha: async () => RECORDED_SHA,
    });
    expect(decision.skip).toBe(false);
  });

  it("a real fix resumes an exhausted workspace — the ceiling is not a dead end", async () => {
    const decision = await shouldSkipMergeForBackoff(WS, {
      database: dbWith({
        failures: MERGE_BACKOFF_MAX_ATTEMPTS + 3,
        signature: "generic|abc",
        branchSha: RECORDED_SHA,
        verifyHash: null,
        nextRetryAt: PAST,
      }),
      getBranchHeadSha: async () => MOVED_SHA,
      hasSubstantiveChangeSince: async () => true,
    });
    expect(decision.skip).toBe(false);
  });
});
