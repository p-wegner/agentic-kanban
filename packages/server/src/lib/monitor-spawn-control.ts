/**
 * An environmental CONTROL spawn for each monitor cycle (#368).
 *
 * ── Why a cycle needs its own control ──
 *
 * This machine has severe, transient, BURSTY spawn/IO stalls. MEASURED, 25 consecutive
 * `git --version` calls (identical command, no repository work, no shell, PowerShell
 * `Measure-Command`, box verified quiet — 0 vitest, 0 serve.mjs), in execution order, ms:
 *
 *   111 80 75 79 81 88 79 | 9461 4794 2201 3530 2502 3453 2577 | 450 530 | 9258 | 72 68 75 |
 *   10203 2068 3019 3372 2456
 *
 * `min=68 p50=2068 max=10203` — 10 of 25 under 200ms, 13 of 25 over 1000ms, in RUNS rather than
 * noise. Independently reproduced (same call 3-10s at 09:21, 1-2ms at 09:23). Not command-specific,
 * not cwd-specific, not repo-size-dependent, not a warm-up effect, not a shell-harness artifact —
 * each of those was ruled out by a control.
 *
 * The consequence is the reason this module exists: **the spread of that distribution exceeds the
 * differences anyone was trying to compare.** Three successive confident diagnoses of the board's
 * slowness were each refuted by the next measurement, and the monitor's "dominant phase" appeared
 * to move four times across rounds — each per-phase figure being one sample from a distribution
 * spanning two orders of magnitude. So a per-cycle number, on its own, cannot distinguish a code
 * regression from a stall window, and no before/after taken without a SIMULTANEOUS control on this
 * box is trustworthy.
 *
 * `git --version` is the control: it is a git spawn (same binary, same adapter, same timing
 * mechanism) that opens no repository, reads no object and touches no index. Anything it costs
 * above its own fast mode is environment, not work.
 *
 * ── Design points that are load-bearing ──
 *
 * - **More than one sample per cycle.** A single sample cannot detect a burst that starts mid-cycle.
 *   Samples are taken at cycle start, at cycle end, and at phase transitions in between (throttled,
 *   capped) — and reported INDIVIDUALLY with min/max beside them. A mean is deliberately NOT
 *   reported: the distribution above is bimodal, and averaging a bimodal distribution is the exact
 *   mistake that produced the wrong diagnoses.
 * - **Same code path as real git.** The probe calls the one sanctioned adapter (`gitExec`) and reads
 *   the durations the adapter itself recorded (`result.timing`), rather than re-timing the call from
 *   outside. A control measured by a different mechanism than the thing it controls for proves
 *   nothing.
 * - **Cheap.** At most `MAX_SAMPLES_PER_CYCLE` spawns against the ~65-120 real git spawns a live
 *   cycle already issues (MEASURED, #368), and they are excluded from the cycle's duplicate-spawn
 *   and child/queue aggregates so they cannot distort the figures they exist to qualify.
 */
import { gitExec, GIT_CONTROL_OPERATION_LABEL } from "@agentic-kanban/shared/lib/git-exec";

/**
 * ── Why there is NO absolute millisecond threshold here ──
 *
 * The first version of this module had one, derived from #368's out-of-process numbers (fast mode
 * 68-111ms, so "300ms cannot be fast mode, 500ms is a stall"). That was wrong, and measuring the
 * probe's OWN code path is what showed it.
 *
 * MEASURED — 80 consecutive control spawns through this exact adapter, in-process via `execFile`,
 * 200ms apart, on a box independently confirmed quiet (0 vitest, no dev server):
 * `min=428  p50=917  max=2411`, and `childMs == totalMs` on essentially every sample (so this is the
 * child's own cost, not our event loop). The in-process floor is therefore ~6x the out-of-process
 * one — Node's spawn path costs what it costs — and the in-process distribution is a CONTINUUM over
 * 428-2411ms rather than the stark two modes PowerShell saw.
 *
 * With a 500ms absolute floor, every cycle on this machine would have reported `stalled: true`
 * forever. An indicator that never disagrees is exactly what the ticket warns is broken. So the
 * indicator is purely RELATIVE to what this process has itself observed, and the raw samples are
 * always exposed beside it.
 *
 * The honest limitation, stated rather than hidden: the baseline is the fastest control spawn THIS
 * PROCESS has seen. A process that has only ever run inside a burst has an inflated baseline and
 * will report `stalled: false` — read `baselineMs` and `baselineSamples` before trusting the flag.
 */

/**
 * Inflation over the process's own fastest control spawn that counts as a stall. MEASURED basis in
 * the 80-sample run above: max/min was 5.6x while the MEDIAN sat at only 2.1x the min, so 4x
 * separates the genuine multi-second outliers from ordinary spread without being tripped by it.
 */
export const STALL_RATIO = 4;

/**
 * A minimum over fewer samples than this is not a mode, it is one draw. Below it the report says
 * "cannot say" rather than offering a ratio against a baseline that has not been established.
 */
export const MIN_BASELINE_SAMPLES = 8;

/** Minimum gap between throttled (phase-transition) samples, so a short cycle stays cheap. */
export const SAMPLE_MIN_GAP_MS = 5_000;

/** Hard cap on control spawns per cycle, including the forced start/end pair. */
export const MAX_SAMPLES_PER_CYCLE = 6;

/**
 * A wedged control spawn must never hold a cycle open for the adapter's ten-minute default. Well
 * above the worst MEASURED stall (10.2s) and far below anything that would matter.
 */
const CONTROL_TIMEOUT_MS = 60_000;

export interface ControlSpawnSample {
  /** When the sample was STARTED. */
  at: string;
  /** Where in the cycle it was taken: `cycle-start`, `cycle-end`, or the phase name entered. */
  position: string;
  /** Call-to-callback ms, as recorded by the git adapter for this very call. */
  totalMs: number;
  /**
   * The child's own lifetime from its `exit` event, or null when it could not be measured.
   * `totalMs - childMs` is what the callback waited on our event loop; a stall shows up in
   * `childMs` (the environment was slow) rather than in the wait (we were busy).
   */
  childMs: number | null;
  /** False when the control spawn itself failed — treat its duration as suspect, not as a stall. */
  ok: boolean;
}

export interface ControlSpawnReport {
  /** Every sample, in order. Read these before any derived figure. */
  samples: ControlSpawnSample[];
  /** Fastest / slowest sample in THIS cycle, or null when no sample was taken. */
  minMs: number | null;
  maxMs: number | null;
  /**
   * Fastest control spawn observed since this process started — a self-calibrating fast-mode
   * reference, so the indicator does not depend on a hardcoded per-machine constant.
   */
  baselineMs: number | null;
  /** How many control samples the process baseline was drawn from. */
  baselineSamples: number;
  /**
   * True once the baseline rests on at least `MIN_BASELINE_SAMPLES` samples. It does NOT claim the
   * baseline is this machine's true fast mode — see the module header: a process that only ever ran
   * inside a burst has an inflated baseline and no way to know it.
   */
  baselineTrusted: boolean;
  /** `maxMs / baselineMs`, rounded to 1dp. Null without an established baseline. */
  inflationRatio: number | null;
  /**
   * Was any part of this cycle measured during a stall — i.e. are this cycle's timings usable?
   *
   * `true` = at least one control spawn was stalled, so nothing timed in this cycle should be
   * compared against another cycle. `false` = every control sample was in fast mode. `null` = no
   * sample, or the only samples failed — the honest answer is "cannot say", NOT "fine".
   */
  stalled: boolean | null;
  /** Plain-language statement of what the above is and is not evidence of. */
  note: string;
}

/**
 * Fastest control spawn this PROCESS has ever seen. Process-wide on purpose: the fast mode is a
 * property of the machine, not of one cycle, and a cycle that happens to run entirely inside a
 * burst has no fast sample of its own to compare against.
 */
let processBaselineMs: number | null = null;
let processBaselineSamples = 0;

export interface SpawnControlProbe {
  /** Take a sample now, unconditionally (cycle start / cycle end). */
  sample(position: string): Promise<void>;
  /**
   * Ask for a sample at a phase transition. Fire-and-forget, throttled by `SAMPLE_MIN_GAP_MS` and
   * capped by `MAX_SAMPLES_PER_CYCLE`, so instrumenting every transition of a long cycle spreads
   * samples across it without adding a spawn per phase to a short one.
   */
  requestSample(position: string): void;
  /** Await any in-flight samples and produce the report. */
  finish(): Promise<ControlSpawnReport>;
}

export function createSpawnControlProbe(nowMs: () => number = () => Date.now()): SpawnControlProbe {
  const samples: ControlSpawnSample[] = [];
  const pending: Array<Promise<void>> = [];
  let startedCount = 0;
  // Seeded with the probe's creation time, NOT 0, so the first phase transition of a cycle does not
  // automatically satisfy the throttle. The opening sample is the explicit `sample("cycle-start")`.
  let lastStartMs = nowMs();

  async function run(position: string): Promise<void> {
    startedCount += 1;
    lastStartMs = nowMs();
    const at = new Date(lastStartMs).toISOString();
    const result = await gitExec(["--version"], {
      timeout: CONTROL_TIMEOUT_MS,
      probeLabel: GIT_CONTROL_OPERATION_LABEL,
    });
    // `timing` is what the adapter handed to `recordOperation` for this call — the same numbers the
    // real operations in this cycle are reported with, not a second opinion.
    const totalMs = result.timing?.totalMs ?? 0;
    const childMs = result.timing?.childMs ?? null;
    const ok = result.error === null;
    samples.push({ at, position, totalMs, childMs, ok });
    if (ok) {
      processBaselineSamples += 1;
      if (processBaselineMs === null || totalMs < processBaselineMs) processBaselineMs = totalMs;
    }
  }

  function start(position: string, cap: number): void {
    if (startedCount >= cap) return;
    // A control spawn must never be the thing that fails a monitor cycle.
    pending.push(run(position).catch(() => {}));
  }

  return {
    async sample(position: string): Promise<void> {
      const before = pending.length;
      start(position, MAX_SAMPLES_PER_CYCLE);
      if (pending.length > before) await pending[before];
    },
    requestSample(position: string): void {
      if (nowMs() - lastStartMs < SAMPLE_MIN_GAP_MS) return;
      // One slot is RESERVED for the explicit closing sample: a burst that starts late in a long
      // cycle is exactly what the closing sample is for, and mid-cycle transitions must not be able
      // to spend the whole budget before it is taken.
      start(position, MAX_SAMPLES_PER_CYCLE - 1);
    },
    async finish(): Promise<ControlSpawnReport> {
      await Promise.all(pending);
      return buildControlSpawnReport(samples, { ms: processBaselineMs, samples: processBaselineSamples });
    },
  };
}

/** The process-lifetime fast-mode reference the indicator is judged against. */
export interface SpawnControlBaseline {
  ms: number | null;
  samples: number;
}

/**
 * Pure, so the indicator's rules are testable against the MEASURED distribution without spawning
 * anything — and so the baseline is an explicit input rather than hidden module state.
 */
export function buildControlSpawnReport(
  samples: ControlSpawnSample[],
  baseline: SpawnControlBaseline,
): ControlSpawnReport {
  const usable = samples.filter((s) => s.ok);
  const durations = usable.map((s) => s.totalMs);
  const minMs = durations.length ? Math.min(...durations) : null;
  const maxMs = durations.length ? Math.max(...durations) : null;
  const baselineMs = baseline.ms;
  const baselineTrusted = baselineMs !== null && baselineMs > 0 && baseline.samples >= MIN_BASELINE_SAMPLES;
  const inflationRatio = baselineTrusted && maxMs !== null
    ? Math.round((maxMs / baselineMs) * 10) / 10
    : null;
  // The WORST sample decides, never a mean: a burst that covers part of the cycle still invalidates
  // comparisons made against that cycle, and a mean over a two-order-of-magnitude spread hides it.
  const stalled = inflationRatio === null ? null : inflationRatio >= STALL_RATIO;
  return {
    samples,
    minMs,
    maxMs,
    baselineMs,
    baselineSamples: baseline.samples,
    baselineTrusted,
    inflationRatio,
    stalled,
    note: describeControlSpawnReport(samples.length, usable.length, stalled, baselineTrusted),
  };
}

function describeControlSpawnReport(
  total: number,
  usable: number,
  stalled: boolean | null,
  baselineTrusted: boolean,
): string {
  if (total === 0) return "no control spawn was taken for this cycle — its timings have no environmental baseline";
  if (usable === 0) return `all ${total} control spawns failed — cannot say whether this cycle was stalled; read the samples`;
  if (!baselineTrusted) {
    return `cannot say: fewer than ${MIN_BASELINE_SAMPLES} control spawns observed in this process, `
      + "so there is no established reference to judge these against. Read the raw samples.";
  }
  const basis = "relative to this process's own fastest control spawn, which may itself have been "
    + "taken during a burst — check baselineMs";
  if (stalled) {
    return `STALLED: at least one control spawn did no repository work and still ran ${STALL_RATIO}x+ slow `
      + `(${basis}). Every duration in this cycle is inflated by the environment; do not compare it `
      + "with another cycle.";
  }
  return `no stall detected in ${usable} control spawn(s) (${basis}). `
    + "Bursts are transient, so this qualifies the sampled instants, not every millisecond in between.";
}

/** Test seam only — the baseline is a process-lifetime observation in production. */
export function resetSpawnControlBaselineForTest(): void {
  processBaselineMs = null;
  processBaselineSamples = 0;
}
