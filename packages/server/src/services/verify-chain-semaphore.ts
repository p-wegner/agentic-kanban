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
 * #949 widened WHO takes a slot, because #903's coverage was narrower than its premise. Three
 * full-suite-scale consumers ran outside it and so re-created the contention it exists to
 * prevent — observed live as two gates at 20 min and >45 min wall on one box, with CPU pinned:
 *   - the gate's boot/render SMOKE check and its E2E lane (both were under the build semaphore
 *     only, whose derived width is up to 8 — i.e. explicitly not serialized),
 *   - the BASE-BRANCH HEALTH probe, which runs the very same verify_script on the same box.
 *     #931 made the probe's scheduler decline to START while a gate held the build semaphore,
 *     but that is one-directional: once a probe was running, a gate arriving afterwards took
 *     its slot immediately and ran a full suite alongside it.
 * All three now acquire this slot, so "one heavyweight verification per box" is a property of
 * the box rather than of one code path.
 *
 * SCOPE, stated plainly: this is in-process module state. It serializes consumers inside ONE
 * server process. A second server, a worktree dev server, or a builder agent running its own
 * `pnpm test:mine` is not bound by it — that is the ticket's "a builder agent is not one
 * worker" observation, and closing it needs a cross-process lock (the shape `repo-lock.ts`
 * already implements, but machine-scoped rather than per-repoPath), not a wider semaphore.
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
 * Run `chain` and also report how long it spent QUEUED (#949).
 *
 * A queued gate was previously indistinguishable from a slow one. Two gates on one box were
 * observed at 20 min and >45 min wall with no signal anywhere saying the second spent most of
 * that waiting rather than working, so the box looked broken instead of busy. The gate's own
 * "a level may only weaken verification VISIBLY" rule applies to the CONDITIONS a verdict was
 * produced under (see `GateTierInfo.buildersQuiesced`), and a 40-minute queue wait is one.
 *
 * Returned rather than exposed as a module-level "last wait" reading: with several consumers
 * now taking slots, a global would be overwritten by whoever acquired most recently, so a
 * caller reading it after its own chain finished could attribute someone else's wait to itself.
 */
export async function runUnderVerifyChainSemaphoreTimed<T>(
  chain: () => Promise<T>,
  label?: string,
): Promise<{ result: T; queueWaitMs: number }> {
  let queueWaitMs = 0;
  const result = await runUnderVerifyChainSemaphore(chain, label, (waited) => { queueWaitMs = waited; });
  return { result, queueWaitMs };
}

/**
 * Run `chain` under the cross-workspace verify-chain semaphore: at most
 * `verifyChainSemaphoreConcurrency()` (default 1) run at once; the rest queue FIFO. Never
 * rejects from the semaphore itself — a chain's own rejection propagates to its caller, and the
 * slot is always released (finally), so one failing/hanging chain can't wedge the queue.
 *
 * `label` names the waiter in the log line emitted when it actually queues (#949). Optional so
 * existing callers and tests are unaffected; a caller that omits it still queues correctly, it
 * is just anonymous in the log. `onWaited` reports the queue wait to the caller — prefer
 * {@link runUnderVerifyChainSemaphoreTimed}, which wraps it.
 */
export async function runUnderVerifyChainSemaphore<T>(
  chain: () => Promise<T>,
  label?: string,
  onWaited?: (queueWaitMs: number) => void,
): Promise<T> {
  if (active >= verifyChainSemaphoreConcurrency()) {
    const queuedAt = Date.now();
    const ahead = waiters.length + active;
    console.log(
      `[verify-chain] ${label ?? "a verify chain"} is QUEUED behind ${ahead} in-flight/waiting chain(s) — `
        + `serializing rather than running concurrently, because N full suites at 1/N speed finish no sooner `
        + `and starve each other (#949)`,
    );
    await new Promise<void>((resolve) => waiters.push(resolve));
    const waited = Date.now() - queuedAt;
    onWaited?.(waited);
    console.log(`[verify-chain] ${label ?? "a verify chain"} acquired its slot after ${Math.round(waited / 1000)}s queued`);
  } else {
    onWaited?.(0);
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
