/**
 * #1151 — repo-lock contention is not a merge FAILURE, and must never be routed to
 * fix-and-merge.
 *
 * A merge refused because another job holds the repo lock (the in-process `activeMerges`
 * refuse/reuse check, or the cross-process on-disk lock check) never even started — there is no
 * conflict and nothing for an agent to fix. `mergeWorkspaceWithFixFallback` used to treat this
 * exactly like an ordinary merge failure and hand it to `fixAndMerge`, which launches an agent
 * and queues a full verify chain for a merge that was never attempted. Every such chain then
 * serializes behind the very lock that caused it (#949), so contention converts directly into
 * queue depth: observed on the operated board as a 1->7 chain backlog over sixteen minutes while
 * a five-ticket merge train held the lock.
 *
 * Same shape as `gate-failure-not-fix-and-merge.test.ts` (#638): a structured `mergeReason` tag
 * on the `WorkspaceError`, read by a predicate, that narrows the fix-and-merge fallback rather
 * than removing it — an ordinary conflict must still get the fix agent.
 */
import { describe, it, expect, vi } from "vitest";
import { mergeWorkspaceWithFixFallback } from "../startup/monitor-cycle-actions.js";
import { isLockContentionFailure, LOCK_CONTENTION_MERGE_REASONS } from "../services/workspace-merge-gate.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { RUN_GATE } from "../services/pre-merge-gate.service.js";

const candidate = {
  wsId: "ws-1151", wsStatus: "idle", workingDir: "/tmp/wt", isDirect: false,
  projectId: "proj-1", issueId: "iss-1", issueTitle: "t", issueNumber: 1151,
  issueStatusName: "In Review", baseBranch: "master", readyForMerge: true,
};
const logs = { conflictMsg: "conflict", successMsg: "ok" };

/** Exactly what the in-process `activeMerges` refuse/reuse check throws. */
function inProcessLockContentionError() {
  return new WorkspaceError(
    "A merge is already in progress for this repository (workspace ws-other, age 2s). Please wait for it to complete.",
    "CONFLICT",
    { mergeReason: "repo_lock_contention", activeWorkspaceId: "ws-other", ageMs: 2000 },
  );
}

/** Exactly what the cross-process on-disk lock check throws (the ticket's observed log). */
function crossProcessLockContentionError() {
  return new WorkspaceError(
    "A merge or other git operation is already in progress for this repository " +
      "(held by merge-train:qmu0m26d0 pid=24284 on AO-PF69VL7N, age 2s). Please wait for it to complete.",
    "CONFLICT",
    { mergeReason: "repo_lock_held_cross_process", holder: "merge-train:qmu0m26d0", holderPid: 24284, holderHostname: "AO-PF69VL7N", ageMs: 2000 },
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

describe("isLockContentionFailure", () => {
  it("is true for the in-process refuse/reuse check's error", () => {
    expect(isLockContentionFailure(inProcessLockContentionError())).toBe(true);
  });

  it("is true for the cross-process on-disk lock check's error", () => {
    expect(isLockContentionFailure(crossProcessLockContentionError())).toBe(true);
  });

  it("is false for a real merge conflict, which carries the same CONFLICT code", () => {
    expect(isLockContentionFailure(new WorkspaceError("merge conflict in src/x.ts", "CONFLICT"))).toBe(false);
  });

  it("is false for repo_lock_unavailable — that failure can NEVER be retried, it is not contention", () => {
    expect(
      isLockContentionFailure(new WorkspaceError("no .git here", "CONFLICT", { mergeReason: "repo_lock_unavailable" })),
    ).toBe(false);
    expect(LOCK_CONTENTION_MERGE_REASONS.has("repo_lock_unavailable")).toBe(false);
  });

  it("reads the structured reason, not the message text (which is prose)", () => {
    expect(isLockContentionFailure(new Error("A merge is already in progress for this repository"))).toBe(false);
    expect(isLockContentionFailure(undefined)).toBe(false);
    expect(isLockContentionFailure("repo_lock_contention")).toBe(false);
  });
});

describe("mergeWorkspaceWithFixFallback — the #1151 lock-contention carve-out", () => {
  it("does NOT launch fix-and-merge when the merge was refused for in-process lock contention", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw inProcessLockContentionError(); }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).not.toHaveBeenCalled();
  });

  it("does NOT launch fix-and-merge when the merge was refused for cross-process lock contention", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw crossProcessLockContentionError(); }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).not.toHaveBeenCalled();
  });

  it("reports the refusal as a FAILED merge, not as a successful fallback", async () => {
    const logged: { endpoint?: string; verificationResult?: string; responseSummary?: string }[] = [];
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw crossProcessLockContentionError(); }),
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
    // fix-and-merge was attempted is how the #638 bypass stayed invisible, and the same trap
    // applies here.
    expect(logged[0].endpoint).toContain("/merge");
    expect(logged[0].endpoint).not.toContain("fix-and-merge");
    expect(logged[0].responseSummary).toContain("lock_contention");
  });

  it("STILL launches fix-and-merge for an ordinary conflict — the fallback narrows, it does not vanish", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => { throw new WorkspaceError("main checkout has uncommitted changes", "CONFLICT"); }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).toHaveBeenCalledWith("ws-1151", "main checkout has uncommitted changes");
  });

  it("STILL launches fix-and-merge for repo_lock_unavailable — that is a real, actionable failure", async () => {
    const fixAndMerge = vi.fn(async () => {});
    const actions = {
      launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(),
      merge: vi.fn(async () => {
        throw new WorkspaceError("cannot lock repo — no .git here", "CONFLICT", { mergeReason: "repo_lock_unavailable" });
      }),
      fixAndMerge,
    };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, noopBackoff);

    expect(fixAndMerge).toHaveBeenCalledWith("ws-1151", "cannot lock repo — no .git here");
  });
});
