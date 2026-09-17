/**
 * #935 follow-up — the on-demand re-probe must not become the saturation it measures.
 *
 * The fix for #935 makes a failing merge gate (and an operator route) ask for a fresh base-health
 * probe whenever the recorded verdict is a non-answer. A probe is a clone + install + a full
 * verify run — on this repo, up to a 45-minute budget. Two guards exist to keep the UNATTENDED
 * periodic sweep from piling that onto a loaded box, and both live in `isBaseHealthProbeDue`, not
 * in the probe:
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
 *
 * **#1165 — an EXPLICIT (`ignoreRecency: true`) request also overrides `gate_running`.** Back-to-
 * back merge gates keep `gateBusy` true almost continuously, so refusing an explicit reprobe on it
 * too made a stuck red base verdict permanently unclearable: the deadlock was gates refuse on a
 * stale base -> gates occupy the semaphore -> the probe that would refresh the base can never
 * start. The `timeout` back-off and the `probe_in_flight` join are untouched, and the probe itself
 * still queues at the real verify-chain semaphore as a background-priority (starvation-bounded)
 * waiter, so this cannot restart the #931 two-full-verifies-at-once failure.
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

// #1196 — `resolveBaseHealthProbeDue` reads the HOST before the clock: free RAM, a 150 ms CPU
// sample (#1009/#1173) and the machine verify lock (#957). Every "DOES probe" case below assumed
// those say "room", which is exactly what a box running the rest of the suite beside this file
// cannot promise — measured as `host_saturated` under `--maxWorkers=2` with the box swapping.
// The guards under test here are gateBusy and the timeout back-off, so the host is pinned roomy
// and the lock switched off; the saturation branch has its own file (`base-health-host-floor`).
vi.mock("@agentic-kanban/shared/lib/machine-capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readTier0Capacity: () => ({ tier: "0", hold: false, reason: "test: pinned roomy", freeGb: 16 }),
    readCpuBusyPct: async () => 0,
  };
});
vi.mock("../lib/machine-verify-lock.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, machineVerifyLockEnabled: () => false };
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

  it("an explicit operator request overrides RECENCY", async () => {
    // The route's reason to exist is "that verdict was starved, measure again now" — so a merely
    // recent row must not block it.
    latestRow.mockResolvedValue({ createdAt: iso(-60_000), outcome: "green" });
    const forced = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: true });
    expect(forced.due).toBe(true);
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
  });

  it("an explicit operator request ALSO overrides gate_running (#1165) — back-to-back gates must not starve it forever", async () => {
    // Back-to-back merge gates keep buildGateBusy() true almost continuously (one ends, the next
    // begins), so a stuck non-answer row could never be re-probed if this pre-check refused an
    // explicit request the same way it refuses the unattended periodic sweep. The probe itself
    // still queues at the real verify-chain semaphore (background priority, its own starvation
    // escape), so this does not reintroduce two full verifies running at once — it only lets the
    // explicit request reach that queue instead of being turned away before it gets there.
    latestRow.mockResolvedValue({ createdAt: iso(-24 * 60 * 60 * 1000), outcome: "red" });
    buildGateBusy.mockReturnValue(true);

    const forced = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: true });

    expect(forced.due).toBe(true);
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
  });

  it("a non-explicit (unattended sweep) request is still refused on gate_running, unchanged", async () => {
    // Only the EXPLICIT on-demand door gets the #1165 override — the periodic sweep must keep
    // yielding to an active gate exactly as before, or #931's original failure mode (the sweep
    // piling an uncoordinated probe onto a box a gate is already using) comes back.
    buildGateBusy.mockReturnValue(true);
    latestRow.mockResolvedValue({ createdAt: iso(-24 * 60 * 60 * 1000), outcome: "timeout" });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict).toEqual({ due: false, reason: "gate_running" });
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

/**
 * #1178 (tests for #1165's second half) — an explicit reprobe must reach the probe AS explicit.
 * `requestBaseBranchReprobe` overriding `gate_running` was only half of #1165: the probe it
 * launched still queued as `background` and still yielded its verify to every gate-class waiter,
 * so `pnpm promote`'s sweep request reached the slot only to give it up again (measured
 * 2026-09-16: two yields, no verdict in 40 min). The `explicit` flag is the wire between the two
 * halves, and this is the test that the wire is connected on both ends.
 */
describe("requestBaseBranchReprobe hands `explicit` to the probe (#1178, #1165)", () => {
  type ProbeCall = [string, unknown, string | undefined, { explicit?: boolean } | undefined];
  const probeCall = (i = 0) => verifyBaseBranchHealth.mock.calls[i] as unknown as ProbeCall;

  it("an `ignoreRecency` request launches the probe with { explicit: true }", async () => {
    latestRow.mockResolvedValue({ createdAt: iso(-60_000), outcome: "green" });

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: true });

    expect(verdict.due).toBe(true);
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
    const [projectId, , now, opts] = probeCall();
    expect(projectId).toBe("p1");
    // No `now` override: the probe stamps its own start, exactly as the sweep's call does.
    expect(now).toBeUndefined();
    expect(opts).toEqual({ explicit: true });
  });

  it("a plain (unattended) request launches the probe with { explicit: false } — background manners unchanged", async () => {
    latestRow.mockResolvedValue(null); // no history -> due

    const verdict = await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW);

    expect(verdict).toEqual({ due: true, reason: "no_history" });
    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
    // `false`, not absent: the flag is always stated, so a reader of the call sees the decision.
    expect(probeCall()[3]).toEqual({ explicit: false });
  });

  it("an `ignoreRecency: false` request is the plain request, not a half-explicit one", async () => {
    latestRow.mockResolvedValue(null);

    await requestBaseBranchReprobe("p1", {} as never, INTERVAL_MS, NOW, { ignoreRecency: false });

    expect(probeCall()[3]).toEqual({ explicit: false });
  });
});
