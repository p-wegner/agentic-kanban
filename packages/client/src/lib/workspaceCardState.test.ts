import { describe, it, expect } from "vitest";
import { deriveWorkspaceCardState } from "./workspaceCardState.js";

type Main = Parameters<typeof deriveWorkspaceCardState>[0];
const main = (o: Record<string, unknown> & { status: string }): Main => o as unknown as Main;

const gate = (phase: "verifying" | "merging" | "stalled", label = "Verifying · 18m") => ({
  phase,
  label,
  detail: "Pre-merge gate attempt 1 (pre-lock-merge) has been running for 18m.",
  quietMs: 0,
  elapsedMs: 0,
  attempt: 1,
  attemptCount: 1,
});

describe("deriveWorkspaceCardState", () => {
  it("picks each state in precedence order", () => {
    expect(deriveWorkspaceCardState(main({ status: "reviewing" })).kind).toBe("reviewing");
    expect(deriveWorkspaceCardState(main({ status: "fixing" })).kind).toBe("fixing");
    expect(deriveWorkspaceCardState(main({ status: "awaiting-plan-approval" })).kind).toBe("awaiting-plan-approval");
    expect(deriveWorkspaceCardState(main({ status: "active", conflicts: { hasConflicts: true } })).kind).toBe("conflicts");
    expect(deriveWorkspaceCardState(main({ status: "active" })).kind).toBe("default");
  });

  /**
   * #944 — the whole reason the gate branch is first. During the gate the workspace's own
   * status is `idle` because the AGENT has finished; every lower branch would therefore render
   * a 30-45 minute verify run exactly like a workspace nobody has touched in a week.
   */
  it("an in-flight gate outranks every other state, including conflicts and reviewing", () => {
    for (const status of ["idle", "reviewing", "fixing", "awaiting-plan-approval", "active"]) {
      const state = deriveWorkspaceCardState(main({ status, conflicts: { hasConflicts: true }, gateActivity: gate("verifying") }));
      expect(state.kind).toBe("gate");
      expect(state.label).toBe("Verifying · 18m");
    }
  });

  it("carries the gate detail through as the label tooltip", () => {
    expect(deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("verifying") })).labelTitle).toContain("pre-lock-merge");
  });

  it("a stalled gate does NOT pulse — a pulsing dot would read as 'working'", () => {
    expect(deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("stalled", "Merge quiet · 1h") })).pulse).toBe(false);
    expect(deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("verifying") })).pulse).toBe(true);
    expect(deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("merging", "Merging · 2m") })).pulse).toBe(true);
  });

  it("stalled and running gates get visibly different surfaces", () => {
    const stalled = deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("stalled") }));
    const running = deriveWorkspaceCardState(main({ status: "idle", gateActivity: gate("verifying") }));
    expect(stalled.surfaceClass).not.toBe(running.surfaceClass);
    expect(stalled.dotClass).not.toBe(running.dotClass);
  });

  it("the default state has no label, so the card shows the branch in that slot", () => {
    const state = deriveWorkspaceCardState(main({ status: "idle" }));
    expect(state.label).toBeNull();
    expect(state.dotClass).toBe("bg-amber-500");
    expect(deriveWorkspaceCardState(main({ status: "active" })).dotClass).toBe("bg-green-500");
    expect(deriveWorkspaceCardState(main({ status: "closed" })).dotClass).toBe("bg-gray-400");
  });

  it("a fixing workspace with conflicts stays `fixing` (conflicts is the lower branch)", () => {
    expect(deriveWorkspaceCardState(main({ status: "fixing", conflicts: { hasConflicts: true } })).kind).toBe("fixing");
  });
});
