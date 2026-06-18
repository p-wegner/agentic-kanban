import { describe, it, expect } from "vitest";
import {
  isBuilderSession,
  decideRateLimitExit,
  formatRateLimitBlockedReason,
  type SpecialSessionSets,
  type RotationOutcome,
} from "../startup/rate-limit-exit-decision.js";

function sets(over: Partial<Record<keyof SpecialSessionSets, string[]>> = {}): SpecialSessionSets {
  return {
    reviewSessionIds: new Set(over.reviewSessionIds ?? []),
    fixAndMergeSessionIds: new Set(over.fixAndMergeSessionIds ?? []),
    learningSessionIds: new Set(over.learningSessionIds ?? []),
  };
}

describe("isBuilderSession", () => {
  it("is true when the session is in none of the special sets", () => {
    expect(isBuilderSession("s1", sets())).toBe(true);
  });

  it.each([
    ["review", { reviewSessionIds: ["s1"] }],
    ["fix-and-merge", { fixAndMergeSessionIds: ["s1"] }],
    ["learning", { learningSessionIds: ["s1"] }],
  ])("is false for a %s session", (_label, over) => {
    expect(isBuilderSession("s1", sets(over))).toBe(false);
  });
});

describe("decideRateLimitExit", () => {
  const rotated: RotationOutcome = { rotated: true, toProfile: "acct-2", reason: "rotated" };
  const notRotated: RotationOutcome = { rotated: false, reason: "all licenses cooled down" };

  it("relaunches only when rotated to a fresh profile AND a builder session", () => {
    expect(decideRateLimitExit(rotated, true).action).toBe("relaunch");
  });

  it("blocks a non-builder session even when rotation succeeded", () => {
    expect(decideRateLimitExit(rotated, false).action).toBe("block");
  });

  it("blocks when no rotation happened, even for a builder", () => {
    expect(decideRateLimitExit(notRotated, true).action).toBe("block");
  });

  it("blocks when rotated reports true but has no toProfile (defensive)", () => {
    expect(decideRateLimitExit({ rotated: true, reason: "x" }, true).action).toBe("block");
  });
});

describe("formatRateLimitBlockedReason", () => {
  it("names the provider's pref key and target profile when rotated", () => {
    const reason = formatRateLimitBlockedReason("Codex", "ws-1", { rotated: true, toProfile: "acct-2", reason: "r" });
    expect(reason).toBe(
      "Codex usage limit reached for workspace ws-1; rotated codex_profile to 'acct-2' (relaunch a builder manually).",
    );
  });

  it("uses claude_profile for the Claude provider", () => {
    const reason = formatRateLimitBlockedReason("Claude", "ws-9", { rotated: true, toProfile: "max-2", reason: "r" });
    expect(reason).toContain("rotated claude_profile to 'max-2'");
  });

  it("surfaces the ring's reason when no rotation happened", () => {
    const reason = formatRateLimitBlockedReason("Claude", "ws-1", { rotated: false, reason: "all subscriptions cooled down" });
    expect(reason).toBe(
      "Claude usage limit reached for workspace ws-1; all subscriptions cooled down. Monitor will not relaunch it automatically.",
    );
  });
});
