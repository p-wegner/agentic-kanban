import { describe, it, expect } from "vitest";
import {
  isAgentRunningStatus,
  occupiesWipSlot,
  holdsLiveResources,
  isTerminalWorkspaceStatus,
  type WorkspaceStatus,
} from "../src/lib/workspace-status.js";

const ALL_STATUSES: WorkspaceStatus[] = [
  "active", "idle", "blocked", "reviewing", "fixing",
  "closed", "ready_for_merge", "awaiting-plan-approval", "error",
];

describe("named liveness questions (#498)", () => {
  it("isAgentRunningStatus is exactly {active, fixing}", () => {
    expect(ALL_STATUSES.filter(isAgentRunningStatus).sort()).toEqual(["active", "fixing"]);
  });

  it("occupiesWipSlot is exactly {active, fixing, reviewing}", () => {
    expect(ALL_STATUSES.filter(occupiesWipSlot).sort()).toEqual(["active", "fixing", "reviewing"]);
  });

  it("a reviewing workspace occupies a slot but has no agent running", () => {
    // The distinction the hand-rolled sets kept blurring: including `reviewing` in the
    // agent-running question makes a reviewing workspace look stalled; excluding it from
    // the WIP question lets the monitor over-start.
    expect(isAgentRunningStatus("reviewing")).toBe(false);
    expect(occupiesWipSlot("reviewing")).toBe(true);
  });

  it("agent-running implies occupying a WIP slot", () => {
    for (const s of ALL_STATUSES) {
      if (isAgentRunningStatus(s)) expect(occupiesWipSlot(s), s).toBe(true);
    }
  });

  it("anything occupying a slot still holds live resources", () => {
    for (const s of ALL_STATUSES) {
      if (occupiesWipSlot(s)) expect(holdsLiveResources(s), s).toBe(true);
    }
  });

  it("holdsLiveResources is the exact complement of terminal — idle and blocked still hold a worktree", () => {
    for (const s of ALL_STATUSES) {
      expect(holdsLiveResources(s), s).toBe(!isTerminalWorkspaceStatus(s));
    }
    expect(holdsLiveResources("idle")).toBe(true);
    expect(holdsLiveResources("blocked")).toBe(true);
    expect(holdsLiveResources("closed")).toBe(false);
  });

  it("all three are safe on null/undefined/unknown", () => {
    for (const bad of [null, undefined, "not-a-status"]) {
      expect(isAgentRunningStatus(bad as string | null)).toBe(false);
      expect(occupiesWipSlot(bad as string | null)).toBe(false);
    }
    // An UNKNOWN status is not terminal, so it is treated as still holding resources —
    // the safe direction: we would rather skip reclamation than delete a live worktree.
    expect(holdsLiveResources("not-a-status")).toBe(true);
  });
});
