/**
 * Cross-workspace SERIALIZATION of pre-merge-gate verify chains (#903).
 *
 * `jvm-build-semaphore.ts` caps how many individual heavyweight invocations (one verify run,
 * one smoke check, one install) run at once, default 2 — but a "verify chain" for a single
 * workspace is often SEVERAL such invocations in sequence (an install retry, a flake-retry
 * re-run), and two DIFFERENT workspaces' chains can freely interleave inside that cap. Observed
 * live: the conductor's fix-and-merge and a second workspace's verify each spawned a full
 * `pnpm check:arch && pnpm typecheck && pnpm test:mine` while a THIRD workspace's merge-gate
 * verify was still mid-suite — three full-suite runs contending for one box, which produced 60s
 * test timeouts, a spurious crash, and a base-health run that read flaky load as a red base and
 * withheld every merge behind it.
 *
 * This semaphore wraps the WHOLE chain (`resolveVerifyOutcome`, which itself may issue several
 * sequential runs) rather than each individual invocation: at most one workspace's verify chain
 * runs at a time per box; the rest queue FIFO. The merge lane is already serialized
 * conceptually (one gate, one merge, one branch lands at a time) — this makes the gate itself
 * enforce that instead of letting concurrent callers race each other onto the same machine.
 *
 * Named a semaphore, not a gate (#611) — it refuses nothing, it only delays.
 */

let active = 0;
const waiters: Array<() => void> = [];

/** Max concurrent verify CHAINS across the whole process. Env-overridable; clamped to >= 1. */
export function verifyChainSemaphoreConcurrency(): number {
  const raw = Number.parseInt(process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/** Current number of in-flight verify chains (for diagnostics/tests). */
export function verifyChainSemaphoreActive(): number {
  return active;
}

/** How many verify chains are queued behind the running one(s) (for diagnostics/tests). */
export function verifyChainSemaphoreQueueLength(): number {
  return waiters.length;
}

/**
 * Run `chain` under the cross-workspace verify-chain semaphore: at most
 * `verifyChainSemaphoreConcurrency()` (default 1) run at once; the rest queue FIFO. Never
 * rejects from the semaphore itself — a chain's own rejection propagates to its caller, and the
 * slot is always released (finally), so one failing/hanging chain can't wedge the queue.
 */
export async function runUnderVerifyChainSemaphore<T>(chain: () => Promise<T>): Promise<T> {
  if (active >= verifyChainSemaphoreConcurrency()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await chain();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** Test seam: reset the semaphore's in-memory state between tests. */
export function resetVerifyChainSemaphoreForTests(): void {
  active = 0;
  waiters.length = 0;
}
