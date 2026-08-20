/**
 * #638 — a RED verify gate must never become an ungated merge.
 *
 * `mergeWorkspaceWithFixFallback` caught EVERY error from `merge()` and handed it to
 * `fixAndMerge`. A pre-merge-gate withhold throws a `WorkspaceError` with code "CONFLICT" (for
 * HTTP-status purposes) tagged `data.mergeReason: "pre_merge_gate_failed"` — so the monitor
 * treated a failing test suite exactly like a dirty worktree. The fix agent's prompt is about
 * working-tree cleanliness and never runs verify/build/tests, yet its exit-0 path merged. Net:
 * every gate failure, and every gate TIMEOUT, converted into a merge with zero verification.
 * No malice required — a slow suite on a loaded box was enough.
 *
 * The merge queue already classified this correctly (#170); these tests pin the monitor path
 * to the same rule, and pin that ordinary conflicts still DO get the fix agent — the fallback
 * must narrow, not disappear.
 */
import { describe, it, expect, vi } from "vitest";
import { mergeWorkspaceWithFixFallback } from "../startup/monitor-cycle-actions.js";
import { isPreMergeGateFailure, PRE_MERGE_GATE_FAILURE_REASON } from "../services/workspace-merge-gate.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { RUN_GATE } from "../services/pre-merge-gate.service.js";

const candidate = {
  wsId: "ws-638", wsStatus: "idle", workingDir: "/tmp/wt", isDirect: false,
  projectId: "proj-1", issueId: "iss-1", issueTitle: "t", issueNumber: 638,
  issueStatusName: "In Review", baseBranch: "master", readyForMerge: true,
};
const logs = { conflictMsg: "conflict", successMsg: "ok" };

/** Exactly what `runPreLockGate` throws when the gate withholds a merge. */
function gateWithholdError(stage: "verify" | "smoke" = "verify") {
  return new WorkspaceError(
    `Pre-merge gate failed (${stage}) — merge withheld. verify_script exited 1`,
    "CONFLICT",
    { mergeReason: PRE_MERGE_GATE_FAILURE_REASON, gateStage: stage },
  );
}

/** `backoff` is given a stub database whose calls are no-ops — the bookkeeping is #417's test. */
const noopBackoff = {
  database: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  },
} as never;

describe("isPreMergeGateFailure", () => {
  it("is true for the withhold the gate actually throws", () => {
    expect(isPreMergeGateFailure(gateWithholdError())).toBe(true);
    expect(isPreMergeGateFailure(gateWithholdError("smoke"))).toBe(true);
  });

  it("is false for a real merge conflict, which carries the same CONFLICT code", () => {
    expect(isPreMergeGateFailure(new WorkspaceError("merge conflict in src/x.ts", "CONFLICT"))).toBe(false);
  });

  it("reads the structured reason, not the message text (which is prose)", () => {
    expect(isPreMergeGateFailure(new Error("Pre-merge gate failed (verify) — merge withheld."))).toBe(false);
    expect(isPreMergeGateFailure(undefined)).toBe(false);
    expect(isPreMergeGateFailure("pre_merge_gate_failed")).toBe(false);
  });
});

describe("mergeWorkspaceWithFixFallback — the #638 bypass", () => {
  it("does NOT launch fix-and-merge when the gate withheld the merge", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw gateWithholdError(); }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).not.toHaveBeenCalled();
  });

  it("reports the withhold as a FAILED merge, not as a successful fallback", async () => {
    const logged: { endpoint?: string; verificationResult?: string; responseSummary?: string }[] = [];
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw gateWithholdError(); }),
      fixAndMerge: vi.fn(async () => {}),
    };

    await mergeWorkspaceWithFixFallback(
      candidate as never, actions as never,
      (_a, _w, _i, extra) => { logged.push(extra ?? {}); },
      logs, RUN_GATE, noopBackoff,
    );

    expect(logged).toHaveLength(1);
    expect(logged[0].verificationResult).toBe("failed");
    // The endpoint must be the MERGE, never the fix-and-merge one — an action log claiming a
    // fix-and-merge was attempted is how this stayed invisible.
    expect(logged[0].endpoint).toContain("/merge");
    expect(logged[0].endpoint).not.toContain("fix-and-merge");
    expect(logged[0].responseSummary).toContain("verify_failed");
  });

  it("STILL launches fix-and-merge for an ordinary conflict — the fallback narrows, it does not vanish", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw new WorkspaceError("main checkout has uncommitted changes", "CONFLICT"); }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).toHaveBeenCalledWith("ws-638", "main checkout has uncommitted changes");
  });
});
