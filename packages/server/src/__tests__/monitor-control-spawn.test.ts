/**
 * #368 — a monitor cycle must carry its own ENVIRONMENTAL CONTROL, because on this machine the
 * spread of the spawn-duration distribution exceeds the differences the cycle timings were being
 * used to compare.
 *
 * MEASURED, 25 consecutive `git --version` calls on a verified-quiet box (identical command, no
 * repository work, PowerShell `Measure-Command`), in execution order, ms:
 *
 *   111 80 75 79 81 88 79 | 9461 4794 2201 3530 2502 3453 2577 | 450 530 | 9258 | 72 68 75 |
 *   10203 2068 3019 3372 2456
 *
 * min=68 p50=2068 max=10203, in RUNS not noise. Those very numbers are replayed through the
 * indicator below, so the rules are locked against the real distribution rather than against an
 * invented one. What CANNOT be tested here is catching a live stall — the machine has to be in a
 * burst for that, so it is an out-of-process acceptance check, not a unit test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildControlSpawnReport,
  createSpawnControlProbe,
  resetSpawnControlBaselineForTest,
  type ControlSpawnSample,
  MAX_SAMPLES_PER_CYCLE,
  MIN_BASELINE_SAMPLES,
  STALL_RATIO,
} from "../lib/monitor-spawn-control.js";
import { createMonitorPhaseRecorder } from "../lib/monitor-phase-timings.js";
import { GIT_CONTROL_OPERATION_LABEL } from "@agentic-kanban/shared/lib/git-exec";

/**
 * The out-of-process distribution above is what put the ticket on the board, but the probe runs
 * IN-PROCESS through `execFile`, and that code path was measured separately before these thresholds
 * were set (an earlier draft of this module hardcoded a 500ms "stall floor" from the numbers above
 * and would have reported EVERY cycle stalled forever).
 *
 * MEASURED — 80 consecutive control spawns through the real adapter, in-process, 200ms apart, on a
 * box independently confirmed quiet: `min=428 p50=917 max=2411`, a continuum rather than two modes.
 * These are the windows the indicator is locked against.
 */
const IN_PROCESS_QUIET = [885, 823, 825, 890, 922, 884, 735, 846, 871, 866, 457, 453, 428, 440, 447];
const IN_PROCESS_BURST = [2266, 2411, 2229, 1658, 2366, 2244, 1607, 1671];

function sample(totalMs: number, position = "processing-candidates"): ControlSpawnSample {
  return { at: new Date().toISOString(), position, totalMs, childMs: totalMs, ok: true };
}

beforeEach(() => resetSpawnControlBaselineForTest());

describe("control-spawn stall indicator (#368)", () => {
  const baseline = { ms: 428, samples: 80 };

  it("DISAGREES between the two MEASURED in-process windows — a flag that never disagrees is broken", () => {
    // This is the acceptance property, in unit-test form: the same rule must call one real window
    // usable and the other not. An earlier draft with a 500ms absolute floor called BOTH of these
    // stalled, which is the failure mode the ticket warns about.
    expect(buildControlSpawnReport(IN_PROCESS_QUIET.map((ms) => sample(ms)), baseline).stalled).toBe(false);
    expect(buildControlSpawnReport(IN_PROCESS_BURST.map((ms) => sample(ms)), baseline).stalled).toBe(true);
  });

  it("is decided by the WORST sample, not a mean — a burst covering part of a cycle still invalidates it", () => {
    // The mistake this whole ticket is a consequence of: averaging over a wide spread. A cycle that
    // was quiet for most samples and stalled for one was still measured during a stall.
    const samples = [...IN_PROCESS_QUIET, 2411].map((ms) => sample(ms));
    const mean = samples.reduce((sum, s) => sum + s.totalMs, 0) / samples.length;
    expect(mean / baseline.ms).toBeLessThan(STALL_RATIO); // a mean would look almost respectable
    expect(buildControlSpawnReport(samples, baseline).stalled).toBe(true);
  });

  it("reports each sample individually plus min/max, and no mean at all", () => {
    const report = buildControlSpawnReport(IN_PROCESS_BURST.map((ms) => sample(ms)), baseline);
    expect(report.samples.map((s) => s.totalMs)).toEqual(IN_PROCESS_BURST);
    expect(report.minMs).toBe(1607);
    expect(report.maxMs).toBe(2411);
    expect(report).not.toHaveProperty("meanMs");
    expect(report.inflationRatio).toBe(Math.round((2411 / 428) * 10) / 10);
  });

  it("says 'cannot say' — never 'not stalled' — until a baseline is actually established", () => {
    const thin = buildControlSpawnReport(IN_PROCESS_BURST.map((ms) => sample(ms)), { ms: 428, samples: MIN_BASELINE_SAMPLES - 1 });
    expect(thin.baselineTrusted).toBe(false);
    expect(thin.inflationRatio).toBeNull();
    expect(thin.stalled).toBeNull();
    expect(thin.note).toContain("cannot say");
  });

  it("refuses to answer when its own reference was taken during a burst", () => {
    // MEASURED on the live board: a cycle whose control spawns took 8998/9022/14600/19618ms was
    // reported `stalled: false`, because that server process had started inside a long burst and its
    // own fastest sample was 5215ms — a ratio of 3.8. A boolean derived from an untrustworthy
    // reference must read "cannot say", never "clean".
    const live = [14600, 19618, 9022, 8998].map((ms) => sample(ms));
    const report = buildControlSpawnReport(live, { ms: 5215, samples: 9 });
    expect(report.baselineTrusted).toBe(false);
    expect(report.stalled).toBeNull();
    expect(report.baselineMs).toBe(5215);
    expect(report.note).toContain("taken during a burst");
  });

  it("still discloses the baseline it judged against when it DID answer", () => {
    const report = buildControlSpawnReport(IN_PROCESS_BURST.map((ms) => sample(ms)), baseline);
    expect(report.baselineMs).toBe(428);
    expect(report.note).toContain("may itself have been taken during a burst");
  });

  it("says 'cannot say' rather than 'not stalled' when there is nothing to go on", () => {
    expect(buildControlSpawnReport([], baseline).stalled).toBeNull();
    const failed: ControlSpawnSample[] = [{ ...sample(9999), ok: false }];
    const report = buildControlSpawnReport(failed, baseline);
    expect(report.stalled).toBeNull();
    expect(report.note).toContain("cannot say");
  });
});

describe("control spawn goes through the real git adapter (#368)", () => {
  it("records itself under its own label, with a child lifetime, via the same code path as real git", async () => {
    const recorder = createMonitorPhaseRecorder("processing-candidates");
    const probe = createSpawnControlProbe();
    await probe.sample("cycle-start");
    await probe.sample("cycle-end");
    const report = await probe.finish();
    const timings = recorder.finish(report);

    expect(report.samples).toHaveLength(2);
    expect(report.samples.map((s) => s.position)).toEqual(["cycle-start", "cycle-end"]);
    for (const s of report.samples) {
      expect(s.ok).toBe(true);
      // The adapter's own numbers, not a second timing taken around it.
      expect(s.totalMs).toBeGreaterThanOrEqual(0);
      expect(s.childMs).not.toBeNull();
      expect(s.childMs!).toBeLessThanOrEqual(s.totalMs);
    }
    // A baseline exists now, drawn from real spawns.
    expect(report.baselineSamples).toBe(2);
    expect(report.baselineMs).toBe(Math.min(...report.samples.map((s) => s.totalMs)));

    // Visible as an operation beside the real subcommands...
    const labels = timings.operations.map((o) => o.label);
    expect(labels).toContain(GIT_CONTROL_OPERATION_LABEL);
    // ...but excluded from the aggregates that describe the cycle's real work, so the instrument is
    // never inside the numbers it qualifies.
    expect(timings.spawnTime.measuredCalls).toBe(0);
    expect(timings.duplicateSpawns.totalCalls).toBe(0);
    expect(timings.duplicateSpawns.duplicateCalls).toBe(0);
    expect(timings.controlSpawn).toBe(report);
  });

  it("throttles phase-transition samples and caps them, so a long cycle is spread and a short one is cheap", async () => {
    let clock = 1_000;
    const probe = createSpawnControlProbe(() => clock);
    await probe.sample("cycle-start");
    // Same instant as the opening sample: throttled away.
    probe.requestSample("loading-preferences");
    probe.requestSample("processing-candidates");
    expect((await probeSnapshot(probe)).length).toBe(1);

    // Far enough apart to be sampled, then hammered past the cap.
    for (let i = 0; i < 20; i++) {
      clock += 10_000;
      probe.requestSample(`phase-${i}`);
    }
    // One slot short of the cap: the last is RESERVED for the explicit closing sample.
    const throttled = await probeSnapshot(probe);
    expect(throttled.length).toBe(MAX_SAMPLES_PER_CYCLE - 1);
    expect(new Set(throttled.map((s) => s.position)).size).toBe(MAX_SAMPLES_PER_CYCLE - 1);

    await probe.sample("cycle-end");
    const samples = await probeSnapshot(probe);
    expect(samples.length).toBe(MAX_SAMPLES_PER_CYCLE);
    expect(samples[samples.length - 1].position).toBe("cycle-end");
  });
});

async function probeSnapshot(probe: ReturnType<typeof createSpawnControlProbe>): Promise<ControlSpawnSample[]> {
  return (await probe.finish()).samples;
}
