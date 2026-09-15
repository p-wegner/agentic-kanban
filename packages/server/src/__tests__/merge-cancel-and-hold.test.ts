import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelQueuedVerifyChain,
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  verifyChainSemaphoreActive,
  verifyChainSemaphoreQueueLength,
} from "../services/verify-chain-semaphore.js";
import {
  beginMergeGateRun,
  hasMergeGateRun,
  requestMergeGateCancellation,
  resetMergeCancellation,
} from "../services/merge-cancellation.js";
import {
  cancelMergeJob,
  getMergeJob,
  resetMergeJobs,
  startMergeJob,
} from "../services/merge-job.service.js";

/**
 * #1164 — the four scenarios the ticket names explicitly:
 *  1. cancelling a QUEUED verify chain lets the next workspace acquire the slot;
 *  2. cancelling an IN-FLIGHT gate signals its AbortSignal (the process-tree kill itself is
 *     `runSetupScript`'s own #989 behaviour, exercised by that module's own tests — this only
 *     verifies the signal reaches it);
 *  3. `cancelMergeJob` marks a running job cancelled and is a no-op on a workspace with no job;
 *  4. the merge-hold callers are covered in `merge-hold-callers.test.ts`.
 */
describe("merge cancel (#1164)", () => {
  beforeEach(() => {
    resetVerifyChainSemaphoreForTests();
    resetMergeCancellation();
    resetMergeJobs();
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    resetMergeCancellation();
    resetMergeJobs();
  });

  it("cancelling a QUEUED chain lets the next waiter acquire the slot immediately", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runUnderVerifyChainSemaphore(async () => {
      await firstGate;
    }, "ws-first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreActive()).toBe(1);

    let secondStarted = false;
    const second = runUnderVerifyChainSemaphore(async () => {
      secondStarted = true;
    }, "ws-second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    const cancelled = cancelQueuedVerifyChain("ws-second");
    expect(cancelled).toBe(true);
    await expect(second).rejects.toThrow(/cancelled while queued/);
    // The slot was never taken by the cancelled waiter — the first chain is still the only
    // active one, and the queue is now empty (freed immediately, not on the first chain's exit).
    expect(verifyChainSemaphoreQueueLength()).toBe(0);
    expect(secondStarted).toBe(false);

    releaseFirst();
    await first;
  });

  it("cancelling a label with no queued waiter is a no-op (false), never throws", () => {
    expect(cancelQueuedVerifyChain("nothing-queued")).toBe(false);
  });

  it("aborts the in-flight gate's signal and clears the registry on end", () => {
    const signal = beginMergeGateRun("ws-inflight");
    expect(signal.aborted).toBe(false);
    expect(hasMergeGateRun("ws-inflight")).toBe(true);

    const requested = requestMergeGateCancellation("ws-inflight");
    expect(requested).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("requesting cancellation for a workspace with no registered gate run is a no-op (false)", () => {
    expect(requestMergeGateCancellation("ws-not-running")).toBe(false);
  });

  it("cancelMergeJob marks a running job cancelled and records why", () => {
    const job = startMergeJob("ws-job", undefined, "test");
    expect(job.state).toBe("running");

    const cancelled = cancelMergeJob("ws-job", "operator cancel");
    expect(cancelled).toBe(true);

    const after = getMergeJob("ws-job");
    expect(after?.state).toBe("cancelled");
    expect(after?.error).toBe("operator cancel");
    expect(after?.reason).toBe("merge_cancelled");
  });

  it("cancelMergeJob is a no-op when no job is running for the workspace", () => {
    expect(cancelMergeJob("ws-idle", "operator cancel")).toBe(false);
  });

  it("cancelMergeJob discards the in-flight attempt with the cancel reason as its detail", () => {
    const job = startMergeJob("ws-attempt", undefined, "test");
    job.attempts.push({ attempt: 1, source: "pre-lock-merge", startedAt: new Date().toISOString() });
    job.attemptCount = 1;

    cancelMergeJob("ws-attempt", "operator said stop");

    const after = getMergeJob("ws-attempt");
    const attempt = after?.attempts[0];
    expect(attempt?.outcome).toBe("discarded");
    expect(attempt?.detail).toBe("operator said stop");
    expect(attempt?.finishedAt).toBeDefined();
  });
});
