/**
 * #243: merge-gate evidence must describe the state the gate actually TESTED.
 *
 * `runPreLockGate` (and `handleReviewSessionExit`) resolved the branch/base tips AFTER
 * `runPreMergeGate` returned. The verify run tests the worktree as it stood at T0; the evidence
 * was stamped with the tip at T0 + 20-40 minutes. Nothing requires the workspace to be stopped
 * while the gate runs, so a still-active builder (or a human) committing into the worktree got
 * its commit stamped as "the verified tip" — and the later merge, seeing the branch "unchanged
 * since gating", landed code the gate never saw while carrying a proof token asserting it did.
 *
 * The fix pins the tips BEFORE the run and re-reads them after; movement means no evidence at
 * all, so the merge executor re-gates under the lock instead of trusting a lie.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";

/** Successive `resolveMergeGateShas` results, consumed in order (before-gate, then after-gate). */
let shaReads: Array<{ branchSha?: string; baseSha?: string }> = [];
let shaReadCount = 0;

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGateShas: vi.fn(async () => {
      const read = shaReads[Math.min(shaReadCount, shaReads.length - 1)];
      shaReadCount++;
      return read;
    }),
    resolveMergeGate: vi.fn(async () => ({
      passed: true,
      ran: true,
      stage: "verify" as const,
      message: "ok",
      decision: "run-gate" as const,
    })),
  };
});

const { runPreLockGate, movedDuringGate } = await import("../services/workspace-merge-gate.js");

const RUN_GATE_TOKEN = { kind: "run-gate" as const };
const workspace = { id: "ws-1", workingDir: "/repo/.worktrees/ws-1", issueId: "issue-1" } as unknown as typeof workspaces.$inferSelect;

async function callRunPreLockGate() {
  return runPreLockGate({
    workspaceId: "ws-1",
    workspace,
    projectId: "project-1",
    baseBranch: "master",
    token: RUN_GATE_TOKEN,
    database: {} as Database,
    recordMergeAttempt: async () => {},
  });
}

describe("movedDuringGate", () => {
  it("reports the branch when the branch tip changed", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a2", baseSha: "b" })).toBe("branch");
  });

  it("reports the base when only the base moved", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a", baseSha: "b2" })).toBe("base");
  });

  it("reports nothing when both tips are unchanged", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a", baseSha: "b" })).toBeNull();
  });

  it("does NOT read an unresolvable tip as movement (a diagnostic read failure is not a commit)", () => {
    expect(movedDuringGate({ branchSha: "a" }, { branchSha: "a", baseSha: "b" })).toBeNull();
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a" })).toBeNull();
    expect(movedDuringGate({}, {})).toBeNull();
  });
});

describe("runPreLockGate pins evidence to the pre-run state (#243)", () => {
  beforeEach(() => {
    shaReadCount = 0;
  });

  it("stamps the tips read BEFORE the gate, not after", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "verified-tip", baseSha: "base-1" },
    ];
    const token = await callRunPreLockGate();
    expect(token.kind).toBe("already-passed");
    if (token.kind !== "already-passed") throw new Error("unreachable");
    expect(token.evidence.branchSha).toBe("verified-tip");
    expect(token.evidence.baseSha).toBe("base-1");
    // Two reads: one before the run, one after — the comparison is what makes the pin honest.
    expect(shaReadCount).toBe(2);
  });

  it("mints NO evidence when a commit lands in the worktree DURING the gate", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "builder-committed-mid-gate", baseSha: "base-1" },
    ];
    const token = await callRunPreLockGate();
    // Falls back to the caller's original token, so the executor re-gates under the lock rather
    // than accepting a proof for a tip the gate never saw.
    expect(token).toBe(RUN_GATE_TOKEN);
  });

  it("mints NO evidence when the BASE moves during the gate (the merge RESULT changed)", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "verified-tip", baseSha: "another-merge-landed" },
    ];
    expect(await callRunPreLockGate()).toBe(RUN_GATE_TOKEN);
  });

  it("still mints evidence when the tips are simply unresolvable (age-only fallback, unchanged)", async () => {
    shaReads = [{}, {}];
    const token = await callRunPreLockGate();
    expect(token.kind).toBe("already-passed");
    if (token.kind !== "already-passed") throw new Error("unreachable");
    expect(token.evidence.branchSha).toBeUndefined();
    expect(token.evidence.baseSha).toBeUndefined();
  });
});
