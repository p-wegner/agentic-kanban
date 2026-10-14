import { describe, expect, it } from "vitest";
import { deriveAutoSlots, evaluateWorkerConcurrency, reserveGbFor, resolveSessionRamGb } from "../src/lib/worker-concurrency.js";

const cap = (o: Record<string, unknown> = {}) =>
  ({ freeRamGb: 20, spareCores: 8, thrashing: "none", totalRamGb: 32, totalCores: 16, ...o }) as never;

describe("auto concurrency derivation (#1456)", () => {
  it("keeps 25% of RAM, never under 4 GB, as the owner's reserve", () => {
    expect(reserveGbFor(32)).toBe(8);
    expect(reserveGbFor(8)).toBe(4);
  });

  it("32 GB / 16 cores gives 4 slots and 8 GB gives 1", () => {
    expect(deriveAutoSlots({ totalRamGb: 32, cores: 16 })).toBe(4);
    expect(deriveAutoSlots({ totalRamGb: 8, cores: 16 })).toBe(1);
  });

  it("honours bounds, cores and disk, and never goes under minSlots", () => {
    expect(deriveAutoSlots({ totalRamGb: 128, cores: 64, minSlots: 1, maxSlots: 8 })).toBe(8);
    expect(deriveAutoSlots({ totalRamGb: 128, cores: 4 })).toBe(2);
    expect(deriveAutoSlots({ totalRamGb: 128, cores: 64, freeDiskGb: 10 })).toBe(2);
    expect(deriveAutoSlots({ totalRamGb: 4, minSlots: 2, maxSlots: 4 })).toBe(2);
  });

  it("a JVM/Gradle stack budgets more RAM per session than the TS default", () => {
    expect(resolveSessionRamGb("node")).toBe(4);
    expect(resolveSessionRamGb("gradle")).toBe(8);
    expect(resolveSessionRamGb("gradle", 6)).toBe(6);
    expect(deriveAutoSlots({ totalRamGb: 64, cores: 32, sessionRamGb: resolveSessionRamGb("gradle") })).toBe(4);
    expect(deriveAutoSlots({ totalRamGb: 32, cores: 32, sessionRamGb: resolveSessionRamGb("gradle") })).toBe(3);
  });
});

describe("evaluateWorkerConcurrency (#1456)", () => {
  const auto = { maxConcurrency: "auto" as const };

  it("auto: derived slots and a reason, no hold on a calm machine", () => {
    const v = evaluateWorkerConcurrency({ declaredSlots: 1, pinned: false, settings: auto, capacity: cap() });
    expect(v).toMatchObject({ mode: "auto", slots: 4, maxSlots: 4 });
    expect(v.hold).toBeUndefined();
    expect(v.reason).toContain("auto: 4 of 4 slots");
  });

  it("backs off on thrashing and on free RAM under the reserve, with the reason", () => {
    const hot = evaluateWorkerConcurrency({ declaredSlots: 1, pinned: false, settings: auto, capacity: cap({ thrashing: "light" }) });
    expect(hot.hold).toContain("thrashing");
    const low = evaluateWorkerConcurrency({ declaredSlots: 1, pinned: false, settings: auto, capacity: cap({ freeRamGb: 5.1 }) });
    expect(low.hold).toBe("auto: 4 of 4 slots, free RAM 5.1 GB under reserve 8.0 GB");
  });

  it("falls back to minSlots until the hardware is reported", () => {
    expect(evaluateWorkerConcurrency({ declaredSlots: 3, pinned: false, settings: { ...auto, minSlots: 2 } }))
      .toMatchObject({ mode: "auto", slots: 2 });
  });

  it("pinned and fixed values win over auto", () => {
    expect(evaluateWorkerConcurrency({ declaredSlots: 2, pinned: true, settings: auto, capacity: cap() }))
      .toMatchObject({ mode: "pinned", slots: 2 });
    const fixed = evaluateWorkerConcurrency({ declaredSlots: 1, pinned: false, settings: { maxConcurrency: 3 }, capacity: cap({ thrashing: "heavy" }) });
    expect(fixed).toMatchObject({ mode: "fixed", slots: 3 });
    expect(fixed.hold).toBeUndefined();
  });
});
