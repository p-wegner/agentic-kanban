/**
 * Whether a RUNNING base-health probe should yield the box's verify slot to a waiting gate-class
 * waiter (#989 — item 3 of #978).
 *
 * #978 landed the two halves that act BEFORE a probe starts: the sha cache (don't start one at
 * all while the base has not moved) and the semaphore's priority classes (admit a queued gate
 * ahead of a queued probe). Neither helps once the probe's VERIFY is running: that run holds the
 * box's single verify slot for up to 45 minutes, and a gate arriving one minute in queues behind
 * it for the rest. That is the remaining half of the ~35-minute wait measured on #971's merge.
 *
 * **The yield therefore has to happen MID-VERIFY, and that is the only place it can happen.** The
 * probe's clone and install run OUTSIDE the slot — they hold nothing, so a gate arriving then
 * acquires the slot immediately and waits zero; there is nothing to yield and no waiter to see.
 * Only while the verify child is running is the probe both holding the thing the gate wants and
 * able to observe the gate queued behind it. So `runBaseBranchProbe` polls
 * `verifyChainGateWaiting()` on {@link PROBE_GATE_POLL_INTERVAL_MS} while its verify runs and
 * kills the child when a gate appears. (An earlier draft put checkpoints between the stages
 * instead; they were dead code by construction, because the flag can never be true there.)
 *
 * Killing the child is safe: the verify runs in a throwaway temp clone that the probe's own
 * `finally` removes. And #949 is preserved — the probe kills its own child BEFORE releasing the
 * slot, so there is never a moment with two heavyweight verifies on the box.
 *
 * It records NOTHING — see `runBaseBranchProbe` — because `timeout` and `unverified` are already
 * the two non-answers and a third outcome would have to be learned by the rot detector, the
 * attribution path and the sha cache alike. A yielded probe is not a measurement that failed; it
 * is a measurement that never happened.
 *
 * Which makes the counting below the load-bearing part, not decoration: a silent abort is exactly
 * how a probe that is preempted every time becomes invisible, and the base's health then silently
 * stops being measured — the failure the probe exists to prevent, reached by optimising it. So
 * every yield is logged and counted per project, and a probe that has yielded
 * {@link probeMaxConsecutiveYields} times IN A ROW runs to completion regardless of who is
 * waiting. Same bound-the-priority shape as `verifyChainBackgroundMaxWaitMs`, one layer in.
 */

/**
 * How often the running verify asks whether a gate has queued behind it.
 *
 * 15s against a verify budget of up to 45 minutes: fine-grained enough that the gate's saved wait
 * is dominated by the abort itself rather than by the polling, and coarse enough that the check
 * (a `some()` over a queue that is almost always empty) is free.
 *
 * Overridable mainly so the tests can drive a real abort in milliseconds instead of waiting out a
 * 15-second tick — the alternative is fake timers around code that also awaits real promises,
 * which is how a test starts asserting the mock instead of the mechanism.
 */
export function probeGatePollIntervalMs(): number {
  const raw = Number.parseInt(process.env.KANBAN_BASE_HEALTH_GATE_POLL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 15_000;
}

/**
 * How many times in a row a project's probe may yield before the next one runs to completion.
 *
 * Three rather than one: a single yield is the common case on a board that merges in bursts, and
 * a bound of one would make the escape fire constantly, which is the same as having no priority
 * at all. Three consecutive yields means the board has been merging continuously across three
 * separate probe attempts, which is when "the base is never measured" stops being hypothetical.
 */
export function probeMaxConsecutiveYields(): number {
  const raw = Number.parseInt(process.env.KANBAN_BASE_HEALTH_MAX_CONSECUTIVE_YIELDS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

/**
 * How much verify a yield must actually THROW AWAY before it counts against the streak.
 *
 * The bound above is there to stop a merge train starving the probe forever. But a yield that
 * happens 3 seconds into a verify discards almost nothing — the probe has barely started, and it
 * will re-run when the base is next due at essentially no cost. Counting those the same as a
 * 40-minute abort lets a burst of three cheap yields exhaust the budget and then force the probe
 * to run to completion *during* the merge train, which is the outcome the bound exists to avoid,
 * reached from the other side.
 *
 * 60s: long enough that anything counted represents real discarded work, short enough that a
 * genuinely repeated preemption still reaches the escape within a few probes. A yield below the
 * floor still LOGS and still aborts — it simply does not consume budget.
 */
export function probeYieldStreakFloorMs(): number {
  const raw = Number.parseInt(process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/**
 * The stage a yield abandoned. Only `verify` is reachable today — it is the one stage that holds
 * the slot — but the field is kept because the log line and any future checkpoint both want to
 * name WHICH stage was thrown away, and a bare "yielded" would not distinguish 3 seconds of
 * install from 40 minutes of suite.
 */
export type ProbeYieldStage = "verify";

export interface ProbeYieldDecision {
  yield: boolean;
  reason: "no_gate_waiting" | "gate_waiting" | "yield_budget_exhausted" | "disabled";
}

/**
 * Pure decision: given "is a gate-class waiter queued for the slot I hold" and how many times
 * this project's probe has already yielded in a row, should the running verify be abandoned?
 *
 * Pure and separable from the counter it is asked about, per the repo's decision-function kind —
 * the whole policy including the anti-thrash escape is a table of cases rather than something
 * only reproducible by racing real 45-minute suites.
 *
 * `disabled` is deliberately distinct from `yield_budget_exhausted` (both say `yield: false`).
 * A bound of 0 means the operator turned preemption OFF, which is a configuration fact and
 * should be silent; an exhausted budget means a gate IS being made to wait and the reader needs
 * to know. Collapsing them logged "already yielded 0 time(s) in a row" as though a streak had
 * been spent, which is both untrue and alarming.
 */
export function shouldProbeYield(input: {
  gateWaiting: boolean;
  consecutiveYields: number;
  maxConsecutiveYields?: number;
}): ProbeYieldDecision {
  const max = input.maxConsecutiveYields ?? probeMaxConsecutiveYields();
  if (max <= 0) return { yield: false, reason: "disabled" };
  if (!input.gateWaiting) return { yield: false, reason: "no_gate_waiting" };
  if (input.consecutiveYields >= max) {
    return { yield: false, reason: "yield_budget_exhausted" };
  }
  return { yield: true, reason: "gate_waiting" };
}

/**
 * Consecutive yields per project, in memory.
 *
 * In memory rather than a preference on purpose: the counter exists to bound thrash WITHIN a run
 * of back-to-back merges, and a process restart ends that run by definition — the probe it would
 * have protected is not the one that comes back. A persisted counter would instead carry a stale
 * "already yielded 3x" across a restart and make the very next probe unyieldable for no reason.
 */
const consecutiveYields = new Map<string, number>();

/** How many times in a row this project's probe has yielded (diagnostics/tests). */
export function probeConsecutiveYields(projectId: string): number {
  return consecutiveYields.get(projectId) ?? 0;
}

/**
 * Record that a probe yielded — the next one is one step closer to the run-to-completion escape.
 *
 * `discardedMs` is how much verify the yield actually threw away. Below
 * {@link probeYieldStreakFloorMs} the yield is real but FREE, so it does not consume budget: see
 * that function for why a cheap yield must not push the probe into running through a merge train.
 * Omitted, the yield always counts (the pre-floor behaviour, and what a caller with no timing to
 * hand should get).
 */
export function recordProbeYield(projectId: string, discardedMs?: number): number {
  const current = probeConsecutiveYields(projectId);
  if (discardedMs !== undefined && discardedMs < probeYieldStreakFloorMs()) return current;
  const next = current + 1;
  consecutiveYields.set(projectId, next);
  return next;
}

/**
 * Record that a probe REACHED A VERDICT, clearing the streak.
 *
 * Called on any completed run, including one that ran only because its budget was exhausted —
 * "consecutive" is the whole point of the bound, and a completed probe is precisely the evidence
 * that the base is still being measured.
 */
export function clearProbeYieldStreak(projectId: string): void {
  consecutiveYields.delete(projectId);
}

/** Test seam: forget every project's streak. */
export function resetProbeYieldStreaksForTests(): void {
  consecutiveYields.clear();
}
