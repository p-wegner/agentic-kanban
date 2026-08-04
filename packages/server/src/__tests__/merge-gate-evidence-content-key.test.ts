import { describe, expect, it } from "vitest";
import { gateAlreadyPassed, resolveMergeGate, MERGE_GATE_EVIDENCE_MAX_AGE_MS } from "../services/pre-merge-gate.service.js";
import type { Database } from "../db/index.js";

/**
 * Content-keyed gate evidence (0108).
 *
 * The behaviour under test is a two-sided trade, and both sides matter:
 *  - THROUGHPUT: evidence pinned to the exact branch+base must stay valid however old it is,
 *    so a merge that queued behind another merge does not re-run a 30-45 minute gate for
 *    nothing.
 *  - SAFETY: evidence whose branch or base has moved must be rejected however FRESH it is,
 *    because the state that was verified no longer exists.
 *
 * `projectId: null` short-circuits `runGateAsResolved` to a no-op, so a rejected token is
 * observable purely through `decision`/`ran` without needing a real repo or verify script.
 */
const db = {} as Database;
const workspace = { id: "ws-1", workingDir: null, baseBranch: "master" };

const ANCIENT = new Date(Date.now() - 10 * MERGE_GATE_EVIDENCE_MAX_AGE_MS).toISOString();
const FRESH = new Date().toISOString();

describe("content-keyed merge gate evidence", () => {
  it("accepts ANCIENT evidence when branch and base still match (no pointless re-gate)", async () => {
    const result = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: ANCIENT, stage: "verify", source: "pre-lock-merge", branchSha: "aaa1", baseSha: "bbb2" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: { branchSha: "aaa1", baseSha: "bbb2" },
    });
    expect(result.decision).toBe("already-passed");
    expect(result.passed).toBe(true);
    expect(result.ran).toBe(false);
  });

  it("REJECTS fresh evidence when the branch moved (a commit landed after the gate)", async () => {
    const result = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: FRESH, stage: "verify", source: "pre-lock-merge", branchSha: "aaa1", baseSha: "bbb2" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: { branchSha: "DIFFERENT", baseSha: "bbb2" },
    });
    expect(result.decision).toBe("run-gate-stale-evidence");
  });

  it("REJECTS fresh evidence when the base moved (another merge landed; the merge RESULT changed)", async () => {
    const result = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: FRESH, stage: "verify", source: "pre-lock-merge", branchSha: "aaa1", baseSha: "bbb2" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: { branchSha: "aaa1", baseSha: "MOVED" },
    });
    expect(result.decision).toBe("run-gate-stale-evidence");
  });

  it("falls back to the age check for legacy evidence carrying no SHAs", async () => {
    const fresh = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: FRESH, stage: "verify", source: "review-exit gate" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: {},
    });
    expect(fresh.decision).toBe("already-passed");

    const stale = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: ANCIENT, stage: "verify", source: "review-exit gate" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: {},
    });
    expect(stale.decision).toBe("run-gate-stale-evidence");
  });

  it("does NOT waive the age check on base-only agreement", async () => {
    // Base matching says nothing about whether the CODE under test is the code being merged,
    // so this must not be treated as a content match.
    const result = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: ANCIENT, stage: "verify", source: "review-exit gate", baseSha: "bbb2" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: { baseSha: "bbb2" },
    });
    expect(result.decision).toBe("run-gate-stale-evidence");
  });

  it("still honours skip-explicit, and still rejects a future-dated legacy timestamp", async () => {
    const skip = await resolveMergeGate({
      token: { kind: "skip-explicit", reason: "fix-and-merge retry" },
      workspace,
      projectId: null,
      database: db,
    });
    expect(skip.decision).toBe("skip-explicit");

    const future = await resolveMergeGate({
      token: gateAlreadyPassed({ ranAt: new Date(Date.now() + 60_000).toISOString(), stage: "verify", source: "x" }),
      workspace,
      projectId: null,
      database: db,
      currentShas: {},
    });
    expect(future.decision).toBe("run-gate-stale-evidence");
  });
});
