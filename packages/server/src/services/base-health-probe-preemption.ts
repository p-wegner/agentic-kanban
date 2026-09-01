/**
 * Whether a RUNNING base-health probe should yield the box's verify slot to a waiting merge
 * gate (#989 — item 3 of #978).
 *
 * #978 landed the two halves that act BEFORE a probe starts: the sha cache (don't start one at
 * all while the base has not moved) and the semaphore's priority classes (admit a queued gate
 * ahead of a queued probe). Neither helps once the probe is already running: it holds the single
 * verify slot for up to clone 5m + install 15m + verify 45m, so a gate arriving one minute in
 * waits it out. That is the remaining half of the ~35-minute wait measured on #971's merge.
 *
 * The probe therefore checks, at its own stage boundaries, whether a gate-class waiter is queued
 * behind it, and if so abandons the run. It records NOTHING — see `runBaseBranchProbe` — because
 * `timeout` and `unverified` are already the two non-answers and a third outcome would have to be
 * learned by the rot detector, the attribution path and the sha cache alike. A yielded probe is
 * not a measurement that failed; it is a measurement that never happened.
 *
 * Which makes the counting below the load-bearing part, not decoration: a silent abort is exactly
 * how a probe that is preempted every time becomes invisible, and the base's health then silently
 * stops being measured — the failure the probe exists to prevent, reached by optimising it. So
 * every yield is logged and counted per project, and a probe that has yielded
 * {@link probeMaxConsecutiveYields} times IN A ROW runs to completion regardless of who is
 * waiting. Same bound-the-priority shape as `verifyChainBackgroundMaxWaitMs`, one layer in.
 */

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
 * The stage a checkpoint sits IN FRONT OF — i.e. the one being abandoned, not the one just
 * finished. Named that way round because it is what the log line needs to say: "yielded before
 * verify" tells a reader the 45-minute stage was avoided, whereas "yielded after install" makes
 * them do the arithmetic.
 */
export type ProbeYieldStage = "clone" | "install" | "verify";

export interface ProbeYieldDecision {
  yield: boolean;
  reason: "no_gate_waiting" | "gate_waiting" | "yield_budget_exhausted";
}

/**
 * Pure decision: given "is a gate queued behind me" and how many times this project's probe has
 * already yielded in a row, should this checkpoint abandon the run?
 *
 * Pure and separable from the counter it is asked about, per the repo's decision-function kind —
 * the whole policy including the anti-thrash escape is a table of cases rather than something
 * only reproducible by racing real 45-minute suites.
 */
export function shouldProbeYield(input: {
  gateWaiting: boolean;
  consecutiveYields: number;
  maxConsecutiveYields?: number;
}): ProbeYieldDecision {
  if (!input.gateWaiting) return { yield: false, reason: "no_gate_waiting" };
  const max = input.maxConsecutiveYields ?? probeMaxConsecutiveYields();
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

/** Record that a probe yielded — the next one is one step closer to the run-to-completion escape. */
export function recordProbeYield(projectId: string): number {
  const next = probeConsecutiveYields(projectId) + 1;
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
