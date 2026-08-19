/**
 * #243: merge-gate evidence must describe the state the gate actually TESTED.
 *
 * The pre-lock merge gate (and `handleReviewSessionExit`) resolved the branch/base tips AFTER
 * the gate returned. The verify run tests the worktree as it stood at T0; the evidence was
 * stamped with the tip at T0 + 20-40 minutes. Nothing requires the workspace to be stopped
 * while the gate runs, so a still-active builder (or a human) committing into the worktree got
 * its commit stamped as "the verified tip" -- and the later merge, seeing the branch "unchanged
 * since gating", landed code the gate never saw while carrying a proof token asserting it did.
 *
 * The protocol pins the tips BEFORE the run and re-reads them after; movement means no evidence
 * at all, so the merge executor re-gates under the lock instead of trusting a lie. Since #540 it
 * lives in ONE place -- `runGateWithEvidence` -- which is what this exercises; the four callers
 * (pre-lock merge, review-exit, both monitor merge paths) hand it their workspace and use the
 * token it returns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";
import type { MergeGateShas, PreMergeGateWorkspace } from "../services/pre-merge-gate.service.js";
import { runGateWithEvidence, movedDuringGate } from "../services/merge-gate-evidence.js";

/** Successive tip reads, consumed in order (before-gate, then after-gate). */
let shaReads: MergeGateShas[] = [];
let shaReadCount = 0;

const gateWorkspace: PreMergeGateWorkspace = { id: "ws-1", workingDir: "/repo/.worktrees/ws-1", baseBranch: "master" };

async function runProtocol(gateResult?: Partial<{ passed: boolean; ran: boolean }>) {
  return runGateWithEvidence({
    workspace: gateWorkspace,
    projectId: "project-1",
    source: "pre-lock-merge",
    database: {} as Database,
    readShas: async () => {
      const read = shaReads[Math.min(shaReadCount, shaReads.length - 1)];
      shaReadCount++;
      return read;
    },
    runGate: async () => ({
      passed: gateResult?.passed ?? true,
      ran: gateResult?.ran ?? true,
      stage: "verify" as const,
      message: "ok",
    }),
  });
}

describe("movedDuringGate", () => {
  it("reports the branch when the branch tip changed", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a2", baseSha: "b" })).toBe("branch");
  });

  it("reports the base when the base tip changed", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a", baseSha: "b2" })).toBe("base");
  });

  it("reports nothing when both tips are unchanged", () => {
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a", baseSha: "b" })).toBeNull();
  });

  it("never reports movement from an unresolvable read", () => {
    expect(movedDuringGate({ branchSha: "a" }, { branchSha: "a", baseSha: "b" })).toBeNull();
    expect(movedDuringGate({ branchSha: "a", baseSha: "b" }, { branchSha: "a" })).toBeNull();
    expect(movedDuringGate({}, {})).toBeNull();
  });
});

describe("runGateWithEvidence pins evidence to the pre-run state (#243)", () => {
  beforeEach(() => {
    shaReadCount = 0;
  });

  it("stamps the tips read BEFORE the gate, not after", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "verified-tip", baseSha: "base-1" },
    ];
    const result = await runProtocol();
    expect(result.token?.kind).toBe("already-passed");
    if (result.token?.kind !== "already-passed") throw new Error("unreachable");
    expect(result.token.evidence.branchSha).toBe("verified-tip");
    expect(result.token.evidence.baseSha).toBe("base-1");
    expect(result.token.evidence.source).toBe("pre-lock-merge");
    // Two reads: one before the run, one after -- the comparison is what makes the pin honest.
    expect(shaReadCount).toBe(2);
  });

  it("mints NO evidence when a commit lands in the worktree DURING the gate", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "builder-committed-mid-gate", baseSha: "base-1" },
    ];
    const result = await runProtocol();
    expect(result.moved).toBe("branch");
    // No token, so the caller keeps its own and the executor re-gates under the lock rather
    // than accepting proof for a tip the gate never saw.
    expect(result.token).toBeNull();
  });

  it("mints NO evidence when the BASE moves during the gate (the merge RESULT changed)", async () => {
    shaReads = [
      { branchSha: "verified-tip", baseSha: "base-1" },
      { branchSha: "verified-tip", baseSha: "another-merge-landed" },
    ];
    const result = await runProtocol();
    expect(result.moved).toBe("base");
    expect(result.token).toBeNull();
  });

  it("still mints evidence when the tips are simply unresolvable (age-only fallback, unchanged)", async () => {
    shaReads = [{}, {}];
    const result = await runProtocol();
    expect(result.token?.kind).toBe("already-passed");
    if (result.token?.kind !== "already-passed") throw new Error("unreachable");
    expect(result.token.evidence.branchSha).toBeUndefined();
    expect(result.token.evidence.baseSha).toBeUndefined();
  });

  it("mints no evidence for a gate that FAILED", async () => {
    shaReads = [{ branchSha: "a" }, { branchSha: "a" }];
    expect((await runProtocol({ passed: false })).token).toBeNull();
  });

  it("still mints for a PASS with nothing to gate on — callers that need a real run check `ran`", async () => {
    shaReads = [{ branchSha: "a" }, { branchSha: "a" }];
    const result = await runProtocol({ ran: false });
    expect(result.ran).toBe(false);
    expect(result.token?.kind).toBe("already-passed");
  });
});

describe("runPreLockGate uses the shared protocol's token", () => {
  it("returns the caller's original token when the protocol withheld evidence", async () => {
    vi.resetModules();
    vi.doMock("../services/merge-gate-evidence.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        runGateWithEvidence: vi.fn(async () => ({
          passed: true,
          ran: true,
          stage: "verify" as const,
          message: "ok",
          shasBefore: { branchSha: "verified-tip" },
          moved: "branch" as const,
          ranAt: new Date().toISOString(),
          token: null,
        })),
      };
    });
    const { runPreLockGate } = await import("../services/workspace-merge-gate.js");
    const RUN_GATE_TOKEN = { kind: "run-gate" as const };
    const token = await runPreLockGate({
      workspaceId: "ws-1",
      workspace: { id: "ws-1", workingDir: "/repo/.worktrees/ws-1", issueId: "issue-1" } as unknown as typeof workspaces.$inferSelect,
      projectId: "project-1",
      baseBranch: "master",
      token: RUN_GATE_TOKEN,
      database: {} as Database,
      recordMergeAttempt: async () => {},
    });
    expect(token).toBe(RUN_GATE_TOKEN);
    vi.doUnmock("../services/merge-gate-evidence.js");
  });
});
