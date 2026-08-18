// @covers pluginLoops.autoLandRecovery [recovery, boundary]
//
// #444 — mealplan step 7, 2026-08-12. A reattached builder exited without an observable code
// (`external exit indeterminate`), so the exit workflow never ran and the `autoLand` path never
// fired. End state: issue Done, branch holding 2947 insertions, workspace idle, master untouched,
// and the loop unable to advance because the planner reads the main checkout.
//
// The stall was already detected and already visible in the inbox. What these tests pin is the
// recovery, and specifically its VETOES: auto-merging is the most destructive thing this pass can
// get wrong, so every test below is about refusing to land rather than landing.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTOLAND_RECOVERY_MIN_AGE_MS,
  shouldRecoverAutoLand,
} from "../services/plugin-loop-autoland-recovery.js";
import type { LoopStall } from "../services/plugin-loop-stall.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function stall(overrides: Partial<LoopStall> = {}): LoopStall {
  return {
    workspaceId: "ws-1",
    issueNumber: 7,
    issueTitle: "PM pipeline 7/9",
    reason: "builder-finished-unmerged",
    mergeSafe: true,
    detail: "",
    since: new Date(NOW - 60 * 60 * 1000).toISOString(),
    contradictoryReadyFlag: false,
    ...overrides,
  };
}

describe("shouldRecoverAutoLand (#444)", () => {
  it("lands the measured state: autoLand loop, builder finished, mergeSafe, aged", () => {
    expect(shouldRecoverAutoLand(stall(), { autoLand: true, nowMs: NOW }).land).toBe(true);
  });

  it("refuses a loop that never opted into autoLand", () => {
    // Stalling is not how a loop acquires the behaviour.
    expect(shouldRecoverAutoLand(stall(), { autoLand: false, nowMs: NOW }).land).toBe(false);
  });

  it("refuses #363's parked stall, where the branch may hold nothing at all", () => {
    const parked = stall({ reason: "workspace-parked-issue-unfinished", mergeSafe: false });
    expect(shouldRecoverAutoLand(parked, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses #445's closed-unmerged stall — its remedy is inspection, not a merge", () => {
    const closed = stall({ reason: "workspace-closed-unmerged", mergeSafe: false });
    expect(shouldRecoverAutoLand(closed, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses an already-landed leftover", () => {
    const leftover = stall({ reason: "unit-already-landed", mergeSafe: false });
    expect(shouldRecoverAutoLand(leftover, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses a mergeSafe:false row even if its reason somehow reads finished", () => {
    // Belt-and-braces: `mergeSafe` is the flag the UI gates its Merge button on, so this pass must
    // never be the one consumer that ignores it.
    const contradictory = stall({ mergeSafe: false });
    expect(shouldRecoverAutoLand(contradictory, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses a stall younger than the floor — never race a workspace mid-exit", () => {
    const fresh = stall({ since: new Date(NOW - 30_000).toISOString() });
    const decision = shouldRecoverAutoLand(fresh, { autoLand: true, nowMs: NOW });
    expect(decision.land).toBe(false);
    expect(decision.reason).toContain("floor");
  });

  it("lands exactly at the floor, not one tick before", () => {
    const atFloor = stall({ since: new Date(NOW - DEFAULT_AUTOLAND_RECOVERY_MIN_AGE_MS).toISOString() });
    const justUnder = stall({ since: new Date(NOW - DEFAULT_AUTOLAND_RECOVERY_MIN_AGE_MS + 1).toISOString() });
    expect(shouldRecoverAutoLand(atFloor, { autoLand: true, nowMs: NOW }).land).toBe(true);
    expect(shouldRecoverAutoLand(justUnder, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses an unreadable timestamp rather than treating it as old", () => {
    // We cannot show the exit path has finished, and this pass never lands on an assumption.
    expect(shouldRecoverAutoLand(stall({ since: "not-a-date" }), { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("refuses when there is no stall at all", () => {
    expect(shouldRecoverAutoLand(null, { autoLand: true, nowMs: NOW }).land).toBe(false);
  });

  it("names the veto, so a skipped recovery is never silent in the log", () => {
    expect(shouldRecoverAutoLand(stall(), { autoLand: false, nowMs: NOW }).reason).toContain("autoLand");
  });
});

/**
 * The git half. `commitsAhead` is mocked because the question under test is what the recovery does
 * with each ANSWER — including the answer git could not give, whose polarity is the opposite of
 * `hasCommitsAhead`'s: that one assumes work exists so it never discards any, this one refuses to
 * merge on an assumption.
 */
describe("recoverStrandedAutoLand — the commits-ahead gate (#444)", () => {
  type Ws = { id: string; workingDir: string | null; baseBranch: string | null };
  const ws: Ws = { id: "ws-1", workingDir: "/repo/wt", baseBranch: "master" };

  async function run(ahead: number | null, workspace: Ws | null = ws) {
    vi.resetModules();
    vi.doMock("@agentic-kanban/shared/lib/git-service", () => ({ getCommitCountAhead: async () => ahead }));
    const { recoverStrandedAutoLand } = await import("../services/plugin-loop-autoland-recovery.js");
    const landed: string[] = [];
    const logs: string[] = [];
    const ok = await recoverStrandedAutoLand(stall(), { autoLand: true, nowMs: NOW }, {
      workspace,
      land: async (id) => { landed.push(id); },
      log: (message) => logs.push(message),
    });
    return { ok, landed, logs: logs.join("\n") };
  }

  it("lands a branch with commits", async () => {
    const result = await run(3);
    expect(result.ok).toBe(true);
    expect(result.landed).toEqual(["ws-1"]);
  });

  it("REFUSES a zero-commit branch — landing it deadlocks the loop without its artifacts", async () => {
    const result = await run(0);
    expect(result.ok).toBe(false);
    expect(result.landed).toEqual([]);
    expect(result.logs).toContain("REFUSED");
  });

  it("refuses when git could not answer", async () => {
    const result = await run(null);
    expect(result.ok).toBe(false);
    expect(result.landed).toEqual([]);
  });

  it("refuses when the workspace has no worktree left to verify against", async () => {
    const result = await run(3, { id: "ws-1", workingDir: null, baseBranch: "master" });
    expect(result.ok).toBe(false);
    expect(result.landed).toEqual([]);
  });

  it("survives a failing merge — a refused gate is a legitimate outcome, not a cycle-killer", async () => {
    vi.resetModules();
    vi.doMock("@agentic-kanban/shared/lib/git-service", () => ({ getCommitCountAhead: async () => 2 }));
    const { recoverStrandedAutoLand } = await import("../services/plugin-loop-autoland-recovery.js");
    const logs: string[] = [];
    const ok = await recoverStrandedAutoLand(stall(), { autoLand: true, nowMs: NOW }, {
      workspace: ws,
      land: async () => { throw new Error("Pre-merge gate failed (typecheck)"); },
      log: (message) => logs.push(message),
    });
    expect(ok).toBe(false);
    expect(logs.join("\n")).toContain("Pre-merge gate failed");
  });
});
