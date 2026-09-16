/**
 * #1009 — the base-health probe counts toward the host-saturation floor the monitor already
 * applies to auto-starts (`tier 0: only X GB free (floor 2GB)`).
 *
 * A probe is a clone + install + full verify. On #999 one ran onto a host fleet reported at
 * 0.6-1.7 GB usable while the branch gate was running its own suite, and both timed out. The
 * monitor would not have started a BUILDER on that box; it must not start a probe either. The
 * rule lives in `isBaseHealthProbeDue` beside the other machine guards, so the sweep, the
 * on-demand door and the merge gate all inherit it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verifyBaseBranchHealth = vi.fn(async () => null);
vi.mock("../services/base-branch-health.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, verifyBaseBranchHealth: (...a: unknown[]) => verifyBaseBranchHealth(...(a as [])) };
});
vi.mock("../services/jvm-build-semaphore.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildGateBusy: () => false };
});
vi.mock("../repositories/base-branch-health.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getLatestBaseBranchHealth: async () => null };
});
vi.mock("../repositories/preferences.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getPreference: async () => null };
});

const { isBaseHealthProbeDue, requestBaseBranchReprobe, resolveBaseHealthProbeDue } = await import(
  "../services/base-branch-health-reprobe.service.js"
);
const { PROBE_MAX_DURATION_MS } = await import("../services/base-branch-health.service.js");

const INTERVAL_MS = 30 * 60 * 1000;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();
const saturated = () => ({ tier: "0" as const, hold: true, reason: "only 1.2GB free (floor 2GB)", freeGb: 1.2 });
const roomy = () => ({ tier: "0" as const, hold: false, reason: "9.0GB free", freeGb: 9 });
// #1173 — pin CPU to an idle reading by default so these RAM-focused cases stay deterministic
// and don't pay for a real 150ms sample; the CPU-specific describe block below overrides it.
const idleCpu = async () => 10;

beforeEach(() => verifyBaseBranchHealth.mockClear());
afterEach(() => vi.clearAllMocks());

describe("isBaseHealthProbeDue — the Tier-0 floor (#1009)", () => {
  it("a due probe on a saturated host is deferred, not run", () => {
    expect(isBaseHealthProbeDue({
      nowMs: NOW, intervalMs: INTERVAL_MS,
      lastResultAt: iso(-25 * 60 * 60 * 1000), lastOutcome: "green",
      hostSaturated: "only 1.2GB free (floor 2GB)",
    })).toEqual({ due: false, reason: "host_saturated" });
  });

  it("a project with NO history is deferred too — a first measurement is still a full suite", () => {
    expect(isBaseHealthProbeDue({ nowMs: NOW, intervalMs: INTERVAL_MS, hostSaturated: "only 0.8GB free (floor 2GB)" }))
      .toEqual({ due: false, reason: "host_saturated" });
  });

  it("null/undefined/empty saturation restores the pre-#1009 decision exactly", () => {
    const base = { nowMs: NOW, intervalMs: INTERVAL_MS, lastResultAt: iso(-2 * INTERVAL_MS), lastOutcome: "green" as const };
    expect(isBaseHealthProbeDue({ ...base }).reason).toBe("interval_elapsed");
    expect(isBaseHealthProbeDue({ ...base, hostSaturated: null }).reason).toBe("interval_elapsed");
    expect(isBaseHealthProbeDue({ ...base, hostSaturated: "" }).reason).toBe("interval_elapsed");
  });

  it("a probe already in flight is reported as in flight, whatever the host looks like", () => {
    expect(isBaseHealthProbeDue({
      nowMs: NOW, intervalMs: INTERVAL_MS,
      probeStartedAt: iso(-(PROBE_MAX_DURATION_MS / 2)),
      hostSaturated: "only 1.2GB free (floor 2GB)",
    }).reason).toBe("probe_in_flight");
  });

  it("a busy gate outranks saturation — the probe yields to the gate, which is the earlier reason", () => {
    expect(isBaseHealthProbeDue({
      nowMs: NOW, intervalMs: INTERVAL_MS, gateBusy: true,
      hostSaturated: "only 1.2GB free (floor 2GB)",
    }).reason).toBe("gate_running");
  });
});

describe("resolveBaseHealthProbeDue / requestBaseBranchReprobe read the live floor (#1009)", () => {
  it("reads Tier-0 capacity and defers when it holds", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: saturated,
      readCpuPct: idleCpu,
    });
    expect(verdict).toEqual({ due: false, reason: "host_saturated" });
  });

  it("probes when the host has room", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: roomy,
      readCpuPct: idleCpu,
    });
    expect(verdict.due).toBe(true);
  });

  it("an EXPLICIT operator re-probe request does not override the floor — it is a machine guard", async () => {
    const verdict = await requestBaseBranchReprobe("p", {} as never, INTERVAL_MS, NOW, {
      ignoreRecency: true,
      readCapacity: saturated,
      readCpuPct: idleCpu,
    });
    expect(verdict).toEqual({ due: false, reason: "host_saturated" });
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });
});

/**
 * #1173 — a base-health probe checked the merge GATE before starting but never the MACHINE's
 * CPU: measured 2026-09-16, a probe ran at 100% CPU start-to-end with free RAM never below
 * 3.1 GB (so the pre-existing RAM-only 2 GB floor never tripped) and burned its full
 * 45-minute cap for a `timeout` — a non-answer, superseding a usable green row. The floor is
 * now BOTH usable RAM (< 4 GB, wider than the 2 GB builder floor since a probe outweighs one
 * agent) OR CPU (>= 85%), the same two thresholds the operating conventions ask a human to
 * check before a parallel test/build run.
 */
describe("resolveBaseHealthProbeDue — the CPU half of the heavier probe floor (#1173)", () => {
  const busyCpu = async () => 97;

  it("defers on CPU saturation alone, even with RAM well above every floor", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: () => ({ tier: "0" as const, hold: false, reason: "4.6GB free", freeGb: 4.6 }),
      readCpuPct: busyCpu,
    });
    expect(verdict).toEqual({ due: false, reason: "host_saturated" });
  });

  it("probes when both CPU and RAM are comfortably under their floors", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: roomy,
      readCpuPct: idleCpu,
    });
    expect(verdict.due).toBe(true);
  });

  it("defers on the wider 4GB RAM floor even when the old 2GB builder floor would not have held", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: () => ({ tier: "0" as const, hold: false, reason: "3.1GB free", freeGb: 3.1 }),
      readCpuPct: idleCpu,
    });
    expect(verdict).toEqual({ due: false, reason: "host_saturated" });
  });

  it("an unreadable CPU sample fails open — RAM alone still decides", async () => {
    const verdict = await resolveBaseHealthProbeDue("p", {} as never, INTERVAL_MS, NOW, {
      readCapacity: roomy,
      readCpuPct: async () => null,
    });
    expect(verdict.due).toBe(true);
  });
});
