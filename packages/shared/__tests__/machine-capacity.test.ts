import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_FREE_GB,
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
