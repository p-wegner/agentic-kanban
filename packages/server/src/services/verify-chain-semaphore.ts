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
 * SCOPE — and #957 is what widened it. This module's own state is still in-process: `active`
 * and `waiters[]` serialize consumers inside ONE server process, and a second server, a worktree
 * dev server, or a builder agent running its own `pnpm test:mine` cannot see either. That is the
 * ticket's "a builder agent is not one worker" observation, and it left the live symptom intact —
 * one gate correctly serialized with three unserialized test runners beside it on the same box.
 *
 * So every acquisition now takes TWO slots, innermost last:
 *   1. the MACHINE lock (`@agentic-kanban/shared/lib/machine-verify-lock`) — cross-process, in
 *      `repo-lock.ts`'s shape but keyed on the machine, since three processes verifying three
 *      DIFFERENT repos starve each other exactly as much as three verifying one;
 *   2. this in-process semaphore — still worth having under it, because it is free, it keeps FIFO
 *      order among this process's own waiters, and it is what bounds us when the machine lock is
 *      switched off.
 *
 * The machine lock is OPT-IN (`KANBAN_MACHINE_VERIFY_LOCK=1`); unset, this module behaves exactly
 * as it did at #949. A caller that cannot acquire it within its role's bound PROCEEDS and says so
 * — see `lockNote`, which the gate puts in its tier message, per "a level may only weaken
 * verification VISIBLY".
 *
 * Named a semaphore, not a gate (#611) — it refuses nothing, it only delays.
 */
import {
  MACHINE_VERIFY_ROLES,
  machineVerifyLockEnabled,
  withMachineVerifyLock,
} from "../lib/machine-verify-lock.js";

/**
 * Which CLASS of work a waiter is (#978).
 *
 * `gate` is a merge waiting to land — something a person or the monitor is blocked on.
 * `background` is a measurement whose result is not time-critical: the base-branch health
 * probe is the one that exists today. Measured 2026-09-01: #971's merge gate waited ~35
 * minutes for this slot behind a base-health probe that was still writing `node_modules`,
 * while the gate itself needed a fraction of that under the 120s impact budget. Both are
 * legitimate users of the box's one verify slot; only one of them has someone waiting.
 *
 * `gate` is the DEFAULT so that every existing caller keeps the exact FIFO behaviour it had —
 * a class nobody opts out of is a class that changes nothing.
 */
export type VerifyChainPriority = "gate" | "background";

/**
 * How long a `background` waiter may be overtaken before it is promoted to strict FIFO (#978).
 *
 * Priority without a starvation bound is how a background job waits forever: merges arrive in
 * bursts on this board and each new gate would jump the probe indefinitely, so the base's
 * health would silently stop being measured — the exact failure the probe exists to prevent,
 * reached by "optimising" it. Past this bound the queue reverts to plain arrival order, so the
 * worst case is a delay, never starvation.
 */
export function verifyChainBackgroundMaxWaitMs(): number {
  const raw = Number.parseInt(process.env.KANBAN_VERIFY_CHAIN_BACKGROUND_MAX_WAIT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
}

interface VerifyChainWaiter {
  resolve: () => void;
  priority: VerifyChainPriority;
  queuedAtMs: number;
  label: string;
}

let active = 0;
const waiters: VerifyChainWaiter[] = [];

/**
 * Choose the next waiter to admit: a `gate` ahead of a `background` one, arrival order within
 * a class, and strict arrival order once any `background` waiter has been overtaken for longer
 * than {@link verifyChainBackgroundMaxWaitMs}.
 *
 * Pure and separable from the queue it serves, so the whole ordering policy — including the
 * starvation escape — is a table of cases rather than something only reproducible by racing
 * real 20-minute suites.
 */
export function chooseNextVerifyChainWaiter(
  queue: Array<{ priority: VerifyChainPriority; queuedAtMs: number }>,
  nowMs: number,
  maxBackgroundWaitMs: number = verifyChainBackgroundMaxWaitMs(),
): number {
  if (queue.length === 0) return -1;
  const starving = queue.some(
    (w) => w.priority === "background" && nowMs - w.queuedAtMs >= maxBackgroundWaitMs,
  );
  if (starving) return 0; // the array is already in arrival order
  const firstGate = queue.findIndex((w) => w.priority === "gate");
  return firstGate === -1 ? 0 : firstGate;
}

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
 * Is a `gate`-class waiter queued right now (#989)?
 *
 * #978's priority classes act only at ADMISSION — they decide who gets the slot next. Once a
 * background probe is running, a gate that arrives a minute later waits out the whole clone +
 * install + verify (up to 65 minutes by the ceilings in `base-branch-health.service.ts`), which
 * is the other half of the ~35-minute wait measured on #971's merge. The running probe needs to
 * be able to ASK, between its stages, whether someone is blocked behind it — and the semaphore
 * is the only thing that knows, because it already classifies its waiters.
 *
 * Deliberately a plain synchronous read of module state rather than a subscription: the caller
 * checks it at natural checkpoints it chooses, so there is no callback to unregister and no way
 * for a stale listener to outlive the chain that installed it.
 *
 * `false` when the semaphore's own state cannot see the waiter — a gate blocked on the
 * CROSS-PROCESS machine lock is invisible here, exactly as it is to `chooseNextVerifyChainWaiter`.
 * That is the same fail-open the rest of this module takes: not yielding costs a delay, yielding
 * on a phantom costs a discarded measurement.
 */
export function verifyChainGateWaiting(): boolean {
  return waiters.some((w) => w.priority === "gate");
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
  opts?: { priority?: VerifyChainPriority },
): Promise<{ result: T; queueWaitMs: number; lockNote: string | null }> {
  let queueWaitMs = 0;
  let lockNote: string | null = null;
  const result = await runUnderVerifyChainSemaphore(
    chain,
    label,
    (waited) => { queueWaitMs = waited; },
    (note) => { lockNote = note; },
    opts,
  );
  return { result, queueWaitMs, lockNote };
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
 *
 * `onUnserialized` (#957) fires only when the work ran WITHOUT the cross-process machine lock,
 * carrying the note that says so. The gate surfaces it; a caller that ignores it is no worse off
 * than before the lock existed, which is why it is optional.
 */
export async function runUnderVerifyChainSemaphore<T>(
  chain: () => Promise<T>,
  label?: string,
  onWaited?: (queueWaitMs: number) => void,
  onUnserialized?: (note: string) => void,
  // An options OBJECT rather than a fifth positional flag (#978): this signature is already at
  // the point where a reader cannot tell the two callbacks apart at a call site, and a bare
  // `"background"` in fifth place would be unreadable. Only the base-health probe passes it.
  opts?: { priority?: VerifyChainPriority },
): Promise<T> {
  const holder = label ?? "a verify chain";
  const priority = opts?.priority ?? "gate";
  // #957 — the MACHINE lock wraps the in-process wait, so `queueWaitMs` covers both and a gate's
  // reported wait is the whole time it spent not-working rather than only the part this process
  // could see. `gate` is the role every consumer of THIS function takes, base-health probe
  // included: it reaches the box through `runUnderVerifyChainSemaphore` like the rest, so it is
  // a proceed-on-timeout waiter here, not the `probe` role's skip. Its yield to a busy verifier
  // happens EARLIER and cheaply — `resolveGateBusy()` defers it before a probe is even started —
  // which is the right place for it, because skipping after a three-hour wait would have burned
  // the clone and install first. `MACHINE_VERIFY_ROLES.probe` is therefore the declared bound for
  // a caller that wants that behaviour, and nothing in the server takes it today.
  if (!machineVerifyLockEnabled()) {
    return runUnderInProcessSemaphore(chain, holder, priority, onWaited);
  }
  // The two waits are reported as ONE number, which is why the in-process half is captured here
  // rather than passed straight through: `runUnderInProcessSemaphore` calls `onWaited` with its
  // own wait only, so handing it the caller's callback would OVERWRITE an hours-long machine-lock
  // wait with the in-process `0` that follows it — a gate that queued two hours behind another
  // process would then report no queue wait at all, which is the silence #957 exists to remove.
  let inProcessWaitMs = 0;
  const outcome = await withMachineVerifyLock(
    MACHINE_VERIFY_ROLES.gate,
    holder,
    () => runUnderInProcessSemaphore(chain, holder, priority, (waited) => { inProcessWaitMs = waited; }),
  );
  onWaited?.(outcome.waitedMs + inProcessWaitMs);
  // `gate.onTimeout` is `"proceed"`, so `ran` is always true here — but the type admits `false`
  // for the `probe` role, and silently treating a skip as a success is exactly the "a green that
  // asserted nothing" shape this codebase keeps having to fix. Fail loudly instead.
  if (!outcome.ran) {
    throw new Error(`[verify-chain] ${holder} was skipped by the machine verify lock: ${outcome.lockNote}`);
  }
  if (outcome.lockNote) onUnserialized?.(outcome.lockNote);
  return outcome.result;
}

/** The pre-#957 body: this process's own FIFO slot, unchanged. */
async function runUnderInProcessSemaphore<T>(
  chain: () => Promise<T>,
  label: string,
  priority: VerifyChainPriority,
  onWaited?: (queueWaitMs: number) => void,
): Promise<T> {
  if (active >= verifyChainSemaphoreConcurrency()) {
    const queuedAt = Date.now();
    const ahead = waiters.length + active;
    console.log(
      `[verify-chain] ${label} is QUEUED (${priority}) behind ${ahead} in-flight/waiting chain(s) — `
        + `serializing rather than running concurrently, because N full suites at 1/N speed finish no sooner `
        + `and starve each other (#949)`,
    );
    await new Promise<void>((resolve) => waiters.push({ resolve, priority, queuedAtMs: queuedAt, label }));
    const waited = Date.now() - queuedAt;
    onWaited?.(waited);
    console.log(`[verify-chain] ${label} acquired its slot after ${Math.round(waited / 1000)}s queued`);
  } else {
    onWaited?.(0);
  }
  active++;
  try {
    return await chain();
  } finally {
    active--;
    // #978 — a merge someone is waiting on goes ahead of a background measurement, with a
    // starvation escape back to arrival order. `chooseNextVerifyChainWaiter` owns the policy.
    const index = chooseNextVerifyChainWaiter(waiters, Date.now());
    if (index >= 0) {
      const [next] = waiters.splice(index, 1);
      next?.resolve();
    }
  }
}

/** Test seam: reset the semaphore's in-memory state between tests. */
export function resetVerifyChainSemaphoreForTests(): void {
  active = 0;
  waiters.length = 0;
}
