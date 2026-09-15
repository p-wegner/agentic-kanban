import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_FREE_GB,
  DEFAULT_DISK_BAD_BLOCK_FLOOR,
  classifyDiskHealth,
  deriveCapacityHold,
  deriveVerifyChainMaxSlots,
  deriveVerifyChainSlots,
  deriveVerifyWorkers,
  MAX_VERIFY_CHAIN_SLOTS,
  readCpuBusyPct,
  readDiskHealthEvents,
  readTier0Capacity,
  resolveSpareCores,
  toWorkerCapacitySnapshot,
} from "../src/lib/machine-capacity.js";

const ENV_KEYS = ["SMART_HOOKS_FORCE", "SMART_HOOKS_MIN_FREE_GB"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("readTier0Capacity", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("does not hold when free memory is comfortably above the floor", () => {
    // The real machine running this test always has far more than 0GB free, so a
    // floor of 0 deterministically exercises the "plenty of room" branch without
    // mocking os.freemem (mirrors the hook's own untested-by-mock style).
    const result = readTier0Capacity({ minFreeGb: 0 });
    expect(result).toEqual({ tier: "0", hold: false, reason: expect.stringContaining("GB free"), freeGb: expect.any(Number) });
  });

  it("holds when the floor is set absurdly high", () => {
    const result = readTier0Capacity({ minFreeGb: 1_000_000 });
    expect(result.tier).toBe("0");
    expect(result.hold).toBe(true);
    expect(result.reason).toContain("floor 1000000GB");
  });

  it("SMART_HOOKS_FORCE=1 always answers no-hold, regardless of the floor", () => {
    savedEnv.SMART_HOOKS_FORCE = process.env.SMART_HOOKS_FORCE;
    process.env.SMART_HOOKS_FORCE = "1";
    const result = readTier0Capacity({ minFreeGb: 1_000_000 });
    expect(result).toEqual({ tier: "0", hold: false, reason: "SMART_HOOKS_FORCE=1", freeGb: null });
  });

  it("falls back to the default floor when SMART_HOOKS_MIN_FREE_GB is malformed", () => {
    savedEnv.SMART_HOOKS_MIN_FREE_GB = process.env.SMART_HOOKS_MIN_FREE_GB;
    process.env.SMART_HOOKS_MIN_FREE_GB = "not-a-number";
    const result = readTier0Capacity({});
    // A malformed env override must not silently disable OR silently over-block the
    // guard — it falls back to DEFAULT_MIN_FREE_GB rather than trusting NaN.
    expect(result.reason.includes(`floor ${DEFAULT_MIN_FREE_GB}GB`) || result.reason.includes("GB free")).toBe(true);
  });

  it("falls back to the default floor when minFreeGb is negative", () => {
    const result = readTier0Capacity({ minFreeGb: -5 });
    expect(result.reason.includes(`floor ${DEFAULT_MIN_FREE_GB}GB`) || result.reason.includes("GB free")).toBe(true);
  });
});

// #1110: box contention for a base-health verdict. os.loadavg() reads [0,0,0] on Windows, so
// this samples os.cpus() twice instead — assert only the shape, since the actual busy % is
// whatever the box running the test happens to be doing.
describe("readCpuBusyPct (#1110)", () => {
  it("returns a percentage in [0, 100]", async () => {
    const pct = await readCpuBusyPct(20);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeGreaterThanOrEqual(0);
    expect(pct as number).toBeLessThanOrEqual(100);
  });
});

// #910: the worker-heartbeat capacity shape (free RAM, spare cores, thrashing).
describe("resolveSpareCores", () => {
  it("never returns a negative count", () => {
    expect(resolveSpareCores({ usedCores: 1_000_000 })).toBe(0);
  });

  it("subtracts the reported used cores from the machine's total", () => {
    const total = resolveSpareCores({ usedCores: 0 });
    expect(total).toBeGreaterThan(0);
    expect(resolveSpareCores({ usedCores: 1 })).toBe(total - 1);
  });
});

describe("toWorkerCapacitySnapshot", () => {
  it("folds a Tier 0 snapshot into the heartbeat shape with thrashing 'none'", () => {
    const snapshot = toWorkerCapacitySnapshot({ tier: "0", hold: false, reason: "3.0GB free", freeGb: 3 });
    expect(snapshot).toEqual({ freeRamGb: 3, spareCores: expect.any(Number), thrashing: "none" });
  });

  it("falls back to 0 free RAM when Tier 0 could not read memory", () => {
    const snapshot = toWorkerCapacitySnapshot({ tier: "0", hold: false, reason: "freemem unreadable", freeGb: null });
    expect(snapshot.freeRamGb).toBe(0);
  });

  it("carries Tier 1's own thrashing value through unchanged", () => {
    const snapshot = toWorkerCapacitySnapshot({
      tier: "1", hold: true, canStartAnother: false, headroomProcesses: 0, thrashing: "heavy",
    });
    expect(snapshot.thrashing).toBe("heavy");
  });
});

describe("deriveVerifyWorkers (#909)", () => {
  it("scales with spare cores on an idle box with plenty of RAM", () => {
    // 16 cores, 28GB free: RAM budget is far bigger than the CPU budget, so CPU decides.
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 28, ceiling: 32 })).toBe(14);
  });

  it("never exceeds the pref ceiling even when the box has room for more", () => {
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 28, ceiling: 6 })).toBe(6);
  });

  it("shrinks under tight RAM even on a many-core box — the loaded-box case measured in #909", () => {
    // 16 cores would budget 14, but 1.5GB free only affords ~5 forks at 0.3GB each.
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 1.5, ceiling: 32 })).toBe(5);
  });

  it("never goes below 1, however tight the box", () => {
    expect(deriveVerifyWorkers({ cpuCount: 2, freeGb: 0.05, ceiling: 32 })).toBe(1);
  });

  it("falls back to the CPU budget when free RAM is unknown (null)", () => {
    expect(deriveVerifyWorkers({ cpuCount: 4, freeGb: null, ceiling: 32 })).toBe(2);
  });

  it("a low ceiling (1) always wins regardless of capacity", () => {
    expect(deriveVerifyWorkers({ cpuCount: 32, freeGb: 64, ceiling: 1 })).toBe(1);
  });
});

/**
 * #1160 — the verify-chain semaphore may now run several chains side by side, and the per-chain
 * worker count is a PARTITION of the box's core budget so that they never add up to more than one
 * chain alone was allowed before. RAM is deliberately not partitioned: it is read live at each
 * chain's start, so a running chain has already taken its share out of the number.
 */
describe("deriveVerifyWorkers with a chain-slot partition (#1160)", () => {
  it("splits the CPU budget evenly across the slots: 16 cores / 3 slots = 4 forks per chain", () => {
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 28, ceiling: 32, chainSlots: 3 })).toBe(4);
  });

  it("the sum of every slot's share never exceeds the unpartitioned budget", () => {
    for (const cpuCount of [2, 4, 6, 8, 12, 16, 32, 64]) {
      const whole = deriveVerifyWorkers({ cpuCount, freeGb: 128, ceiling: 64 });
      for (const chainSlots of [1, 2, 3, 4]) {
        const share = deriveVerifyWorkers({ cpuCount, freeGb: 128, ceiling: 64, chainSlots });
        // A share is floored at 1, so on a box with fewer cores than slots the bound is the
        // floor itself — which is why `deriveVerifyChainMaxSlots` never offers such a box more
        // than one slot in the first place.
        const slotsThisBoxWouldOffer = Math.min(chainSlots, deriveVerifyChainMaxSlots(cpuCount));
        expect(share * slotsThisBoxWouldOffer).toBeLessThanOrEqual(whole);
      }
    }
  });

  it("`chainSlots` omitted or 1 is the whole budget — the build semaphore and builder env are untouched", () => {
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 28, ceiling: 32 })).toBe(14);
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 28, ceiling: 32, chainSlots: 1 })).toBe(14);
  });

  it("RAM is not divided again — a tight box is bounded by live RAM, not by RAM/slots", () => {
    // 1.5 GB free affords 5 forks at 0.3 GB; the CPU share (4) is lower and wins. If RAM were
    // partitioned too, this would read 1.
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 1.5, ceiling: 32, chainSlots: 3 })).toBe(4);
    expect(deriveVerifyWorkers({ cpuCount: 16, freeGb: 0.9, ceiling: 32, chainSlots: 3 })).toBe(3);
  });

  it("still never goes below 1", () => {
    expect(deriveVerifyWorkers({ cpuCount: 2, freeGb: 28, ceiling: 32, chainSlots: 3 })).toBe(1);
  });
});

describe("deriveVerifyChainMaxSlots — the CPU partition (#1160)", () => {
  it("offers 3 slots on a 16-core box (14 budget / 2 min forks = 7, capped at the maximum)", () => {
    expect(deriveVerifyChainMaxSlots(16)).toBe(MAX_VERIFY_CHAIN_SLOTS);
  });

  it("offers 3 on an 8-core box (6 / 2) and 2 on a 6-core box (4 / 2)", () => {
    expect(deriveVerifyChainMaxSlots(8)).toBe(3);
    expect(deriveVerifyChainMaxSlots(6)).toBe(2);
  });

  it("offers ONE slot on a box whose budget cannot carry two 2-fork chains — the old behaviour", () => {
    expect(deriveVerifyChainMaxSlots(4)).toBe(1);
    expect(deriveVerifyChainMaxSlots(2)).toBe(1);
    expect(deriveVerifyChainMaxSlots(1)).toBe(1);
  });
});

describe("deriveVerifyChainSlots — how many chains may run right now (#1160)", () => {
  const idle16 = { cpuCount: 16, active: 0 };

  it("a 16-core box with plenty of RAM opens every slot the CPU partition allows", () => {
    // 20 GB free: (20 - 2) / 3 = 6 more would fit by RAM; CPU caps it at 3.
    const r = deriveVerifyChainSlots({ ...idle16, freeGb: 20 });
    expect(r.slots).toBe(3);
    expect(r.maxSlots).toBe(3);
    expect(r.pinned).toBe(false);
  });

  it("the Conductor's own reading — 9.4 GB free on this box — opens exactly two", () => {
    // (9.4 - 2) / 3 = 2.46 -> 2 more fit. This is the measured case the ticket is about: one
    // gate ran while a second waited two hours with this much RAM idle.
    expect(deriveVerifyChainSlots({ ...idle16, freeGb: 9.4 }).slots).toBe(2);
  });

  it("clamps back to ONE when RAM is tight, however many cores there are", () => {
    expect(deriveVerifyChainSlots({ ...idle16, freeGb: 4.9 }).slots).toBe(1); // (4.9-2)/3 < 1
    expect(deriveVerifyChainSlots({ ...idle16, freeGb: 1 }).slots).toBe(1);   // below the reserve
    expect(deriveVerifyChainSlots({ ...idle16, freeGb: 0 }).slots).toBe(1);
  });

  it("clamps to ONE on a small box whatever the RAM", () => {
    expect(deriveVerifyChainSlots({ cpuCount: 4, freeGb: 40, active: 0 }).slots).toBe(1);
  });

  it("is `active + how many MORE fit`: a running chain has already taken its RAM out of the reading", () => {
    // One chain running, 5.5 GB still free: (5.5 - 2) / 3 = 1 more fits -> 2 slots.
    expect(deriveVerifyChainSlots({ cpuCount: 16, freeGb: 5.5, active: 1 }).slots).toBe(2);
    // One chain running, 4 GB free: nothing more fits -> the running one is the only slot, and a
    // newcomer waits (active >= slots).
    expect(deriveVerifyChainSlots({ cpuCount: 16, freeGb: 4, active: 1 }).slots).toBe(1);
    // Two running, 8 GB free: RAM would fit two more, CPU allows only one more -> 3.
    expect(deriveVerifyChainSlots({ cpuCount: 16, freeGb: 8, active: 2 }).slots).toBe(3);
    // Three running (the maximum): never more than the partition, whatever RAM says.
    expect(deriveVerifyChainSlots({ cpuCount: 16, freeGb: 40, active: 3 }).slots).toBe(3);
  });

  it("a pin replaces the derivation in both directions and becomes the partition", () => {
    const pinnedDown = deriveVerifyChainSlots({ ...idle16, freeGb: 40, pinned: 1 });
    expect(pinnedDown).toMatchObject({ slots: 1, maxSlots: 1, pinned: true });
    const pinnedUp = deriveVerifyChainSlots({ cpuCount: 2, freeGb: 0.5, active: 0, pinned: 4 });
    expect(pinnedUp).toMatchObject({ slots: 4, maxSlots: 4, pinned: true });
  });

  it("with free RAM unreadable, only the CPU partition bounds (fail-open, like every other reader)", () => {
    expect(deriveVerifyChainSlots({ ...idle16, freeGb: null }).slots).toBe(3);
    expect(deriveVerifyChainSlots({ cpuCount: 4, freeGb: null, active: 0 }).slots).toBe(1);
  });

  it("names the numbers it decided on, for the queue log line", () => {
    const r = deriveVerifyChainSlots({ ...idle16, freeGb: 9.4 });
    expect(r.reason).toContain("2 slot(s)");
    expect(r.reason).toContain("9.4 GB free");
    expect(r.reason).toContain("16 cores");
  });
});

// #1127: host disk-health signal (bad-block / interrupted-write events) surfaced alongside
// the CPU/RAM capacity check, so a setup/gate failure with the same timestamp reads as a
// machine condition rather than another phantom pnpm bug.
describe("classifyDiskHealth (#1127)", () => {
  it("is not degraded when both counts are at/under their floors", () => {
    const result = classifyDiskHealth({ diskBadBlockEvents: DEFAULT_DISK_BAD_BLOCK_FLOOR - 1, ntfsInterruptedWriteEvents: 0 });
    expect(result.degraded).toBe(false);
    expect(result.reason).not.toContain("may be failing hardware");
  });

  it("is degraded once bad-block events reach the flag-worthy floor", () => {
    const result = classifyDiskHealth({ diskBadBlockEvents: DEFAULT_DISK_BAD_BLOCK_FLOOR, ntfsInterruptedWriteEvents: 0 }, 7);
    expect(result.degraded).toBe(true);
    expect(result.windowDays).toBe(7);
    expect(result.reason).toContain("may be failing hardware, not the project (#1127)");
  });

  it("is degraded by even a single NTFS interrupted-write event, regardless of the bad-block count", () => {
    const result = classifyDiskHealth({ diskBadBlockEvents: 0, ntfsInterruptedWriteEvents: 1 });
    expect(result.degraded).toBe(true);
  });

  it("defaults to a 7-day window", () => {
    expect(classifyDiskHealth({ diskBadBlockEvents: 0, ntfsInterruptedWriteEvents: 0 }).windowDays).toBe(7);
  });
});

describe("readDiskHealthEvents (#1127)", () => {
  it("never throws, and returns null on a non-Windows host", async () => {
    if (process.platform === "win32") return;
    await expect(readDiskHealthEvents()).resolves.toBeNull();
  });

  it("on Windows, resolves to null or a valid signal — never rejects, never hangs past its own budget", async () => {
    if (process.platform !== "win32") return;
    const result = await readDiskHealthEvents({ timeoutMs: 5000 });
    if (result !== null) {
      expect(result.diskBadBlockEvents).toBeGreaterThanOrEqual(0);
      expect(result.ntfsInterruptedWriteEvents).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);
});

describe("deriveCapacityHold (#1029) - the Conductor's projection of a snapshot", () => {
  it("a saturated Tier 1 snapshot holds, allows zero new starts, and names the measured numbers", () => {
    const hold = deriveCapacityHold(
      { tier: "1", hold: true, canStartAnother: false, headroomProcesses: 0, thrashing: "heavy" },
      { maxNewStartsPerCycle: 3 },
    );
    expect(hold.hold).toBe(true);
    expect(hold.tier).toBe("1");
    expect(hold.maxNewStarts).toBe(0);
    expect(hold.headroomProcesses).toBe(0);
    expect(hold.thrashing).toBe("heavy");
    expect(hold.reason).toContain("0 headroom process(es)");
    expect(hold.reason).toContain("thrashing=heavy");
  });

  it("an unsaturated Tier 1 snapshot caps new starts at the measured headroom, never above the per-cycle cap", () => {
    const roomy = deriveCapacityHold(
      { tier: "1", hold: false, canStartAnother: true, headroomProcesses: 5, thrashing: "none" },
      { maxNewStartsPerCycle: 3 },
    );
    expect(roomy.hold).toBe(false);
    expect(roomy.maxNewStarts).toBe(3);
    const tight = deriveCapacityHold(
      { tier: "1", hold: false, canStartAnother: true, headroomProcesses: 1, thrashing: "light" },
      { maxNewStartsPerCycle: 3 },
    );
    expect(tight.maxNewStarts).toBe(1);
    // No cap given: the measured headroom is the answer.
    expect(deriveCapacityHold({ tier: "1", hold: false, canStartAnother: true, headroomProcesses: 2, thrashing: "none" }).maxNewStarts).toBe(2);
  });

  it("a negative headroom from the fleet tool is clamped to 0, never a negative start budget", () => {
    const hold = deriveCapacityHold(
      { tier: "1", hold: false, canStartAnother: true, headroomProcesses: -2, thrashing: "none" },
      { maxNewStartsPerCycle: 3 },
    );
    expect(hold.maxNewStarts).toBe(0);
  });

  it("a held Tier 0 read allows zero starts and carries the free-GB figure", () => {
    const hold = deriveCapacityHold(
      { tier: "0", hold: true, reason: "only 1.2GB free (floor 2GB)", freeGb: 1.2 },
      { maxNewStartsPerCycle: 3 },
    );
    expect(hold.hold).toBe(true);
    expect(hold.tier).toBe("0");
    expect(hold.maxNewStarts).toBe(0);
    expect(hold.freeGb).toBe(1.2);
    expect(hold.headroomProcesses).toBeNull();
    expect(hold.reason).toContain("only 1.2GB free");
  });

  it("an unheld Tier 0 read does not fabricate a headroom: the cap passes through, or null without one", () => {
    const withCap = deriveCapacityHold({ tier: "0", hold: false, reason: "8.0GB free", freeGb: 8 }, { maxNewStartsPerCycle: 3 });
    expect(withCap.hold).toBe(false);
    expect(withCap.maxNewStarts).toBe(3);
    const noCap = deriveCapacityHold({ tier: "0", hold: false, reason: "8.0GB free", freeGb: 8 });
    expect(noCap.maxNewStarts).toBeNull();
  });
});
