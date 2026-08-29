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

const { requestBaseBranchReprobe } = await import("../startup/base-branch-health-reconciler.js");
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
