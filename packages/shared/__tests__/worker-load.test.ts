import { describe, it, expect } from "vitest";
import { cpuPctBetween, sumCpuTicks, sharesHost, isLoadSuspect, isRunningSlow } from "../src/lib/worker-load.js";
import { parseWorkerCapacityInfo } from "../src/lib/worker-capacity-parse.js";

describe("worker load (#1658)", () => {
  it("computes cpu % from tick deltas", () => {
    const a = sumCpuTicks([{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }]);
    const b = sumCpuTicks([{ times: { user: 40, nice: 0, sys: 30, idle: 130, irq: 0 } }]);
    expect(cpuPctBetween(a, b)).toBe(50);
    expect(cpuPctBetween(a, a)).toBeUndefined();
  });
  it("detects shared host and load-suspect", () => {
    expect(sharesHost({ hostFingerprint: "x" }, { hostFingerprint: "x" })).toBe(true);
    expect(sharesHost({}, {})).toBe(false);
    expect(isLoadSuspect([{ timedOut: true }], 95)).toBe(true);
    expect(isLoadSuspect([{ timedOut: true }, { timedOut: false }], 95)).toBe(false);
    expect(isLoadSuspect([{ timedOut: true }], undefined)).toBe(false);
    expect(isRunningSlow(31, 20)).toBe(true);
    expect(isRunningSlow(25, 20)).toBe(false);
  });
  it("parses new optional fields and leaves old workers unknown", () => {
    const old = parseWorkerCapacityInfo({ freeRamGb: 1, spareCores: 2, thrashing: "none" });
    expect(old?.cpuPct).toBeUndefined();
    const n = parseWorkerCapacityInfo({ freeRamGb: 1, spareCores: 2, thrashing: "none", cpuPct: 87, hostFingerprint: "f", jobCounts: { "rc-sweep": 1 }, foreignHeavyProcs: 3 });
    expect(n).toMatchObject({ cpuPct: 87, hostFingerprint: "f", jobCounts: { "rc-sweep": 1 }, foreignHeavyProcs: 3 });
  });
});
