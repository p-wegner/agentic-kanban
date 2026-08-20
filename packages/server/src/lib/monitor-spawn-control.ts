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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * The remaining limitation is real, and it BIT on the live board: the baseline is the fastest control
 * spawn THIS PROCESS has seen, so a server started inside a long burst has an inflated reference.
 * MEASURED — a live cycle whose control spawns took 8998/9022/14600/19618ms was reported
 * `stalled: false`, because that process's own fastest sample was 5215ms and the ratio came to 3.8.
 * The samples disclosed it; the boolean did not.
 *
 * The fix is for the indicator to REFUSE TO ANSWER when its own reference is not credible, rather
 * than answer "false" — see `BASELINE_PLAUSIBILITY_CEILING_MS`. It still never asserts a stall on an
 * absolute threshold; the absolute number only ever downgrades an answer to "cannot say".
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

/**
 * A baseline above this cannot be this machine's fast mode, so it is not fit to judge anything
 * against — the report says "cannot say" instead of comparing to it.
 *
 * This is the ONE absolute number in the module and it is deliberately one-directional: it can only
 * withhold an answer, never produce a `stalled: true`. MEASURED derivation, same in-process code
 * path: over 80 consecutive control spawns on a quiet box the WHOLE distribution was 428-2411ms with
 * p50 917ms, so a supposed fast-mode reference above 2000ms sits at the very top of (or outside) the
 * entire observed range and is far more likely to be a burst sample than a floor. The live example in
 * the module header had a 5215ms baseline.
 */
export const BASELINE_PLAUSIBILITY_CEILING_MS = 2000;

/**
 * The SECOND, relative way a baseline can qualify — and the fix for #375/#374.
 *
 * MEASURED, why the absolute ceiling alone made the indicator unusable: over 14 monitor cycles /
 * 75 control samples on this box, `baselineMs` sat pinned at 2346ms — 346ms above the ceiling —
 * while `baselineSamples` rose 14 -> 84 with no process restart. **0 of 75 samples fell below
 * 2000ms** (window min 2696ms), so nothing could ever lower it. Result: `stalled: null` on 14 of
 * 14 cycles, one identical withholding note, never a `true` and never a `false`. A machine whose
 * whole in-process distribution sits above the constant is permanently disqualified from being
 * measured at all, which is the same "indicator that never disagrees" failure the module header
 * warns about, only in the withholding direction.
 *
 * So plausibility is now also askable RELATIVELY, against the process's own observed distribution:
 * a baseline is a credible fast-mode reference if it is at least `STALL_RATIO` times faster than
 * this process's MEDIAN control spawn. The fraction is deliberately `1 / STALL_RATIO` rather than a
 * second tunable — if the baseline is a genuine floor, then a median-typical sample is itself
 * already "stalled" relative to it, and the two numbers are then saying the same thing.
 *
 * Checked against every distribution MEASURED on this machine (baseline / p50 = ratio, vs the 0.25
 * threshold):
 * - quiet box, 80 samples (min 428, p50 917): 0.47 — FAILS the relative test but passes the
 *   absolute ceiling. Trusted, as it must be; the two tests are OR'd for exactly this case.
 * - the live false negative in the module header (baseline 5215, cycle 8998/9022/14600/19618,
 *   p50 11811): 0.44 — fails BOTH, so it stays "cannot say". That MEASURED miss is what the
 *   absolute ceiling was added for and it must not regress; it does not.
 * - this loaded box, 75 samples (baseline 2346, p50 19955): 0.12 — passes relatively. The
 *   indicator can finally answer here, and it answers `stalled: true`, which is correct: a
 *   zero-work `git --version` measured 51.8 SECONDS in that window.
 *
 * The threshold therefore has ~2x of margin on the "must trust" side (0.12) and ~1.8x on the "must
 * withhold" side (0.44), against real measurements rather than invented ones.
 */
export const BASELINE_RELATIVE_CEILING_FRACTION = 1 / STALL_RATIO;

/**
 * How many of this process's own control durations the relative test's median is taken over.
 *
 * Bounded because the process is long-lived; 512 is far more than the ~6/cycle a monitor takes and
 * the memory is negligible. The window is RECENT rather than lifetime on purpose: "what is typical
 * for this machine right now" is the question the relative test asks.
 */
export const OBSERVED_WINDOW_SIZE = 512;

/**
 * A persisted baseline older than this is discarded rather than trusted.
 *
 * The point of persisting (the other half of #375) is that a baseline learned in a quiet moment
 * survives the `tsx watch` reloads that happen dozens of times a day — NOT that a number from last
 * month keeps certifying stalls forever. A week is long enough to span a reload storm and short
 * enough that a genuine change in the machine ages out.
 */
export const BASELINE_PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Filename of the cross-process baseline store, inside the board's data dir. */
export const BASELINE_STORE_FILENAME = "monitor-spawn-baseline.json";

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
  /** Every sample, ordered by when it STARTED. Read these before any derived figure. */
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
   * True once the baseline rests on at least `MIN_BASELINE_SAMPLES` samples AND is itself plausible
   * as a fast-mode reading — EITHER absolutely (<= `BASELINE_PLAUSIBILITY_CEILING_MS`) OR relative
   * to this process's own median control spawn (see `BASELINE_RELATIVE_CEILING_FRACTION`, #375).
   * When false, `stalled` is `null` rather than `false`: an untrustworthy reference must not be
   * allowed to certify a cycle as clean.
   */
  baselineTrusted: boolean;
  /**
   * WHICH plausibility test the baseline passed, or null when it passed neither (or there were too
   * few samples). Disclosed because the two answer different questions and a reader comparing
   * cycles needs to know which one qualified this figure.
   */
  baselineTrustBasis: "absolute-ceiling" | "relative-to-median" | null;
  /**
   * Median of the distribution the relative test was taken against — this process's recent control
   * durations when it has them, otherwise this cycle's own. Null when there is nothing to take.
   */
  observedMedianMs: number | null;
  /**
   * The persisted baseline that SEEDED this process, or null when none was loaded (no store, store
   * too old, or persistence disabled). Non-null means this process can judge a cycle from its very
   * first samples instead of waiting to observe its own fast mode — the `tsx`-reload gap in #375.
   */
  baselineSeededFromMs: number | null;
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
/** Recent control durations this process has observed, for the relative plausibility test (#375). */
let observedDurations: number[] = [];
/** The persisted value this process was seeded with, purely so the report can disclose it. */
let baselineSeededFromMs: number | null = null;
/** Persistence is loaded at most once per process, and skipped entirely under test. */
let persistenceLoaded = false;
/** `auto` = decide from the environment. `off`/`on` are only ever set by the test seam. */
let persistenceMode: "auto" | "off" | "on" = "auto";

/** On-disk shape of the cross-process baseline store. */
export interface PersistedBaseline {
  ms: number;
  samples: number;
  at: string;
}

/**
 * Read + validate the store. Returns null for every failure mode — missing, unreadable, malformed,
 * non-positive, or older than `BASELINE_PERSIST_MAX_AGE_MS`. Pure apart from the read, so the
 * acceptance rules are testable without process state.
 */
export function readBaselineStore(path: string, nowMs: number = Date.now()): PersistedBaseline | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedBaseline>;
    if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms) || raw.ms <= 0) return null;
    const at = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
    if (Number.isNaN(at)) return null;
    if (nowMs - at > BASELINE_PERSIST_MAX_AGE_MS) return null;
    const samples = typeof raw.samples === "number" && raw.samples > 0 ? Math.floor(raw.samples) : 0;
    return { ms: raw.ms, samples, at: raw.at as string };
  } catch {
    return null;
  }
}

/** Write the store. Never throws — a baseline that could not be saved is not a cycle failure. */
export function writeBaselineStore(path: string, payload: PersistedBaseline): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Best effort by design.
  }
}

function persistenceIsOff(): boolean {
  if (persistenceMode !== "auto") return persistenceMode === "off";
  const env = process.env;
  // Same test detection as `db-path.ts`: a suite must never inherit a real machine's baseline, and
  // must never write one either.
  if (env.VITEST || env.NODE_ENV === "test") return true;
  return env.KANBAN_SPAWN_BASELINE_PERSIST === "0";
}

function baselineStorePath(): string {
  const override = process.env.KANBAN_SPAWN_BASELINE_FILE;
  if (override && override.trim()) return override.trim();
  // Resolved WITHOUT importing the db layer: the store is a probe artifact, not board data, and a
  // path helper is not worth an extra edge in the dependency graph. `AGENTIC_KANBAN_DIR` is the same
  // override the DB honours, so the two land side by side on a machine that sets it.
  const dir = process.env.AGENTIC_KANBAN_DIR?.trim();
  if (dir) return join(dir, BASELINE_STORE_FILENAME);
  return join(tmpdir(), BASELINE_STORE_FILENAME);
}

/**
 * Seed the process baseline from the on-disk store, once.
 *
 * Never throws and never blocks: a missing, unreadable, malformed or stale store just means this
 * process learns its own baseline the slow way, exactly as before #375.
 */
function loadPersistedBaseline(): void {
  if (persistenceLoaded) return;
  persistenceLoaded = true;
  if (persistenceIsOff()) return;
  const stored = readBaselineStore(baselineStorePath());
  if (!stored) return;
  baselineSeededFromMs = stored.ms;
  processBaselineMs = stored.ms;
  // The persisted sample count carries over so a freshly reloaded process is not withheld for
  // `MIN_BASELINE_SAMPLES` cycles on evidence it already has.
  processBaselineSamples = Math.max(processBaselineSamples, stored.samples);
}

/** Write the improved baseline out so the next process (after any `tsx` reload) starts with it. */
function persistBaseline(): void {
  if (persistenceIsOff() || processBaselineMs === null) return;
  writeBaselineStore(baselineStorePath(), {
    ms: processBaselineMs,
    samples: processBaselineSamples,
    at: new Date().toISOString(),
  });
}

/** Median of a duration list, or null when empty. Used by the relative plausibility test. */
function medianMs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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
  // A baseline learned in a quiet moment must survive a `tsx watch` reload (#375), so the store is
  // read before this cycle's first sample rather than left to be relearned.
  loadPersistedBaseline();
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
      observedDurations.push(totalMs);
      if (observedDurations.length > OBSERVED_WINDOW_SIZE) {
        observedDurations = observedDurations.slice(-OBSERVED_WINDOW_SIZE);
      }
      if (processBaselineMs === null || totalMs < processBaselineMs) {
        processBaselineMs = totalMs;
        // Only on an IMPROVEMENT, so the store is written a handful of times per process life
        // rather than once per spawn.
        persistBaseline();
      }
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
      return buildControlSpawnReport(samples, {
        ms: processBaselineMs,
        samples: processBaselineSamples,
        observedMs: observedDurations,
        seededFromMs: baselineSeededFromMs,
      });
    },
  };
}

/** The process-lifetime fast-mode reference the indicator is judged against. */
export interface SpawnControlBaseline {
  ms: number | null;
  samples: number;
  /**
   * This process's recent control durations, for the RELATIVE plausibility test (#375). Optional so
   * the rules stay testable from a bare window; when omitted the cycle's own durations are used,
   * which is the honest fallback — it is the only distribution then in evidence.
   */
  observedMs?: number[];
  /** Persisted baseline this process was seeded with, for disclosure only. */
  seededFromMs?: number | null;
}

/**
 * Pure, so the indicator's rules are testable against the MEASURED distribution without spawning
 * anything — and so the baseline is an explicit input rather than hidden module state.
 */
export function buildControlSpawnReport(
  unordered: ControlSpawnSample[],
  baseline: SpawnControlBaseline,
): ControlSpawnReport {
  // Sorted by START time, because samples are appended when they COMPLETE and a slow one finishes
  // after a later, faster one. The live endpoint showed `cycle-end` listed before the `auto-start`
  // sample that began two seconds earlier, which makes a reader misjudge when a burst began.
  const samples = [...unordered].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const usable = samples.filter((s) => s.ok);
  const durations = usable.map((s) => s.totalMs);
  const minMs = durations.length ? Math.min(...durations) : null;
  const maxMs = durations.length ? Math.max(...durations) : null;
  const baselineMs = baseline.ms;
  const observedMedianMs = medianMs(
    baseline.observedMs && baseline.observedMs.length > 0 ? baseline.observedMs : durations,
  );
  const hasEnough = baselineMs !== null && baselineMs > 0 && baseline.samples >= MIN_BASELINE_SAMPLES;
  // Two independent ways to qualify, OR'd. Both can only ever GRANT an answer that the sample count
  // already allows; neither can manufacture a `stalled: true` on its own.
  const passesAbsolute = hasEnough && baselineMs <= BASELINE_PLAUSIBILITY_CEILING_MS;
  const passesRelative = hasEnough
    && observedMedianMs !== null
    && baselineMs <= observedMedianMs * BASELINE_RELATIVE_CEILING_FRACTION;
  const baselineTrustBasis = passesAbsolute
    ? ("absolute-ceiling" as const)
    : passesRelative
      ? ("relative-to-median" as const)
      : null;
  const baselineTrusted = baselineTrustBasis !== null;
  const inflationRatio = baselineTrusted && maxMs !== null
    ? Math.round((maxMs / baselineMs!) * 10) / 10
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
    baselineTrustBasis,
    observedMedianMs,
    baselineSeededFromMs: baseline.seededFromMs ?? null,
    inflationRatio,
    stalled,
    note: describeControlSpawnReport(samples.length, usable.length, stalled, baselineTrustBasis),
  };
}

function describeControlSpawnReport(
  total: number,
  usable: number,
  stalled: boolean | null,
  baselineTrustBasis: ControlSpawnReport["baselineTrustBasis"],
): string {
  if (total === 0) return "no control spawn was taken for this cycle — its timings have no environmental baseline";
  if (usable === 0) return `all ${total} control spawns failed — cannot say whether this cycle was stalled; read the samples`;
  // ASCII only. These notes are read back out of JSON by humans and agents through several layers
  // (PowerShell console, curl, the board UI), and an em dash came back through the live endpoint as
  // mojibake the first time this shipped.
  if (baselineTrustBasis === null) {
    return "cannot say: this process has no credible fast-mode reference to judge against - either "
      + `fewer than ${MIN_BASELINE_SAMPLES} control spawns so far, or its own fastest spawn is above `
      + `${BASELINE_PLAUSIBILITY_CEILING_MS}ms AND is less than ${STALL_RATIO}x faster than its own `
      + "median spawn, so it was itself probably taken during a burst. Read the raw samples, "
      + "baselineMs and observedMedianMs.";
  }
  const basis = baselineTrustBasis === "absolute-ceiling"
    ? "relative to this process's own fastest control spawn, which may itself have been taken "
      + "during a burst - check baselineMs"
    : `relative to this process's own fastest control spawn, qualified as a floor because it is `
      + `${STALL_RATIO}x+ faster than this process's median spawn - check baselineMs and `
      + "observedMedianMs";
  if (stalled) {
    return `STALLED: at least one control spawn did no repository work and still ran ${STALL_RATIO}x+ slow `
      + `(${basis}). Every duration in this cycle is inflated by the environment; do not compare it `
      + "with another cycle.";
  }
  return `no stall detected in ${usable} control spawn(s) (${basis}). `
    + "Bursts are transient, so this qualifies the sampled instants, not every millisecond in between.";
}

/**
 * Test seam only — the baseline is a process-lifetime observation in production.
 *
 * Latches persistence OFF by default: a suite must neither inherit the developing machine's real
 * baseline nor write one back over it. `{ persist: true }` turns it back on for the one test that
 * exercises the store itself, which must point `KANBAN_SPAWN_BASELINE_FILE` at a temp path.
 */
export function resetSpawnControlBaselineForTest(options?: { persist?: boolean }): void {
  processBaselineMs = null;
  processBaselineSamples = 0;
  observedDurations = [];
  baselineSeededFromMs = null;
  persistenceMode = options?.persist ? "on" : "off";
  persistenceLoaded = false;
}

/**
 * Test seam only — force the store to be read now and report what it seeded, so the cross-process
 * half of #375 is testable without spawning a second server.
 */
export function loadPersistedBaselineForTest(): { ms: number | null; samples: number; seededFrom: number | null } {
  loadPersistedBaseline();
  return { ms: processBaselineMs, samples: processBaselineSamples, seededFrom: baselineSeededFromMs };
}
