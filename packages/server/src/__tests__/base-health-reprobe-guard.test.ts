/**
 * #935 follow-up — the on-demand re-probe must not become the saturation it measures.
 *
 * The fix for #935 makes a failing merge gate (and an operator route) ask for a fresh base-health
 * probe whenever the recorded verdict is a non-answer. A probe is a clone + install + a full
 * verify run — on this repo, up to a 45-minute budget. Two guards already existed to keep that
 * from piling onto a loaded box, and BOTH live in `isBaseHealthProbeDue`, not in the probe:
 *
 *   - `gateBusy` (#931): a merge gate is spending the cores right now, so the probe — the least
 *     urgent of the three test-spawning paths — yields.
 *   - the `timeout` back-off (#712): a probe that burned its whole budget is not due again until
 *     it has had at least its own runtime to breathe.
 *
 * `verifyBaseBranchHealth`'s in-flight map dedups probes that OVERLAP; it does not decide whether
 * one should start. So calling it directly from the gate would re-spawn a full verify on every
 * failing gate for as long as the sticky non-answer row stands — the exact machine saturation
 * that produced the false TIMEOUT verdict in the first place. Every "probe if it makes sense"
 * caller therefore goes through `requestBaseBranchReprobe`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The probe itself is never run here — that is the whole point of the guard under test.
const verifyBaseBranchHealth = vi.fn(async () => null);
vi.mock("../services/base-branch-health.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, verifyBaseBranchHealth: (...a: unknown[]) => verifyBaseBranchHealth(...(a as [])) };
});

const buildGateBusy = vi.fn(() => false);
vi.mock("../services/jvm-build-semaphore.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildGateBusy: () => buildGateBusy() };
});

const latestRow = vi.fn<() => Promise<{ createdAt: string; outcome: string } | null>>(async () => null);
vi.mock("../repositories/base-branch-health.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getLatestBaseBranchHealth: () => latestRow() };
});

const probeStartedAt = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock("../repositories/preferences.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getPreference: () => probeStartedAt() };
});

const { requestBaseBranchReprobe, isBaseHealthProbeDue } = await import("../services/base-branch-health-reprobe.service.js");
const { PROBE_MAX_DURATION_MS } = await import("../services/base-branch-health.service.js");

/** The sweep's own default interval, passed explicitly so this test never depends on it. */
const INTERVAL_MS = 30 * 60 * 1000;
const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

beforeEach(() => {
  verifyBaseBranchHealth.mockClear();
  buildGateBusy.mockReturnValue(false);
  latestRow.mockResolvedValue(null);
  probeStartedAt.mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("requestBaseBranchReprobe yields to the machine guards (#935)", () => {
  it("does NOT probe while a merge gate holds the box", async () => {
    // The #931 yield. A gate's verify is running; the base probe is the one that gives way.
    // Without this, a failing gate would immediately spawn a rival full test run.
    buildGateBusy.mockReturnValue(true);
    latestRow.mockResolvedValue({ createdAt: iso(-24 * 60 * 60 * 1000), outcome: "timeout" });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict).toEqual({ due: false, reason: "gate_running" });
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("does NOT probe while another probe is already in flight", async () => {
    probeStartedAt.mockResolvedValue(iso(-60_000));
    latestRow.mockResolvedValue({ createdAt: iso(-24 * 60 * 60 * 1000), outcome: "timeout" });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict).toEqual({ due: false, reason: "probe_in_flight" });
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("does NOT re-probe a timeout that has not yet had its own runtime to breathe (#712 back-off)", async () => {
    // This is the sticky-row case the gate hits: a fresh TIMEOUT row, and a gate failing every
    // monitor cycle. One probe, not one per cycle.
    latestRow.mockResolvedValue({ createdAt: iso(-60_000), outcome: "timeout" });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict.due).toBe(false);
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("DOES probe once the timeout back-off has elapsed", async () => {
    latestRow.mockResolvedValue({
      createdAt: iso(-(INTERVAL_MS + PROBE_MAX_DURATION_MS + 60_000)),
      outcome: "timeout",
    });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict.due).toBe(true);
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
  });

  it("returns the DECISION without waiting for the probe to finish", async () => {
    // A probe is minutes to an hour; a failing gate and an HTTP handler both have to carry on.
    let releaseProbe: () => void = () => {};
    verifyBaseBranchHealth.mockImplementationOnce(
      () => new Promise((resolve) => { releaseProbe = () => resolve(null); }),
    );
    latestRow.mockResolvedValue(null); // no history -> due

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict).toEqual({ due: true, reason: "no_history" });
    releaseProbe();
  });

  it("an explicit operator request overrides RECENCY but never the machine guards", async () => {
    // The route's reason to exist is "that verdict was starved, measure again now" — so a merely
    // recent row must not block it...
    latestRow.mockResolvedValue({ createdAt: iso(-60_000), outcome: "green" });
    const forced = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: true });
    expect(forced.due).toBe(true);
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);

    // ...but a busy gate still wins, because that is the load the starved verdict came from.
    verifyBaseBranchHealth.mockClear();
    buildGateBusy.mockReturnValue(true);
    const held = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: true });
    expect(held).toEqual({ due: false, reason: "gate_running" });
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });
});

/**
 * #978 — master only moves on a merge, so a 30-minute interval re-probes an UNCHANGED base and
 * pays clone + install + full verify for information already recorded. That probe holds the
 * box's single verify slot: #971's merge gate waited ~35 minutes behind exactly one of them.
 */
describe("#978: an unchanged base sha is not due", () => {
  const base = { nowMs: Date.parse("2026-09-01T12:00:00.000Z"), intervalMs: 30 * 60 * 1000 };
  /** Old enough that the interval alone would say "due". */
  const longAgo = "2026-09-01T10:00:00.000Z";

  it("skips when the last ANSWER was recorded at the sha the base is still on", () => {
    const verdict = isBaseHealthProbeDue({
      ...base,
      lastResultAt: longAgo,
      lastOutcome: "green",
      lastResultSha: "abc123",
      currentSha: "abc123",
    });

    expect(verdict).toEqual({ due: false, reason: "sha_unchanged" });
  });

  it("a RED answer is just as much an answer — an unchanged broken base is not re-measured", () => {
    expect(
      isBaseHealthProbeDue({ ...base, lastResultAt: longAgo, lastOutcome: "red", lastResultSha: "abc123", currentSha: "abc123" }),
    ).toEqual({ due: false, reason: "sha_unchanged" });
  });

  it("a NON-answer at the same sha is still due — the probe learned nothing about it", () => {
    // `timeout`/`unverified` say something about the probe, not about the base. Skipping on
    // those would cache a non-answer forever at a sha that never moves again.
    for (const outcome of ["timeout", "unverified"] as const) {
      const verdict = isBaseHealthProbeDue({
        ...base,
        // Past the timeout back-off (interval + the probe ceiling), so `timeout` is due on age.
        lastResultAt: "2026-09-01T09:00:00.000Z",
        lastOutcome: outcome,
        lastResultSha: "abc123",
        currentSha: "abc123",
      });
      expect(verdict.due, `${outcome} at an unchanged sha must still probe`).toBe(true);
    }
  });

  it("a MOVED base is due exactly as before", () => {
    expect(
      isBaseHealthProbeDue({ ...base, lastResultAt: longAgo, lastOutcome: "green", lastResultSha: "abc123", currentSha: "def456" }),
    ).toEqual({ due: true, reason: "interval_elapsed" });
  });

  it("an UNREADABLE current sha falls back to the interval — fail-open, never fail-quiet", () => {
    // The failure mode of the other direction is a base whose health is never re-measured
    // again, so an unresolvable sha must cost an extra probe rather than skip one.
    for (const currentSha of [null, undefined, ""]) {
      expect(
        isBaseHealthProbeDue({ ...base, lastResultAt: longAgo, lastOutcome: "green", lastResultSha: "abc123", currentSha }).due,
        `currentSha=${JSON.stringify(currentSha)} must not suppress the probe`,
      ).toBe(true);
    }
  });

  it("does not outrank the two guards that protect the machine", () => {
    // A running gate and an in-flight probe are about the BOX, not about what is known; an
    // unchanged sha must not turn either into "not due" for the wrong reason.
    const unchanged = { lastResultAt: longAgo, lastOutcome: "green" as const, lastResultSha: "abc", currentSha: "abc" };
    expect(isBaseHealthProbeDue({ ...base, ...unchanged, gateBusy: true }).reason).toBe("gate_running");
    expect(
      isBaseHealthProbeDue({ ...base, ...unchanged, probeStartedAt: "2026-09-01T11:59:00.000Z" }).reason,
    ).toBe("probe_in_flight");
  });

  it("still probes a project with NO history at all", () => {
    expect(isBaseHealthProbeDue({ ...base, currentSha: "abc123", lastResultSha: null }).reason).toBe("no_history");
  });
});
