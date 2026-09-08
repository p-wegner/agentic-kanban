/**
 * #1057 — a saturated host must not START a verify chain.
 *
 * MEASURED, 2026-09-07: three independent branches (#1046, #1048, #1049) each ran a full
 * pre-merge gate on a box at 100% CPU that was swapping 2334 pages/s. Each failed in a
 * DIFFERENT test batch after ~28 minutes — 85 minutes of wall clock that established nothing
 * about any of the three diffs, and not one of the three failures was even attributable,
 * because the verify log truncates before naming the failing suite (#1049, itself one of the
 * three branches that could not land).
 *
 * The signal already existed and the gate simply never asked: `gate-quiesce.ts` held BUILDER
 * starts while a gate ran (#581/#909), and the base-health probe has declined to measure a base
 * on a tight box since #1009 — the gate, running the very same verify script, started regardless.
 */
import { describe, it, expect } from "vitest";
import { decideGateHostAdmission } from "../services/gate-quiesce.js";

describe("gate host admission (#1057)", () => {
  it("admits a gate when the box has room", () => {
    const a = decideGateHostAdmission({ capacityHold: false, capacityReason: "4.0 GB free", floorEnabled: true });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe("host_has_room");
  });

  it("refuses a gate when the host is saturated, and carries the measured reason", () => {
    const a = decideGateHostAdmission({
      capacityHold: true,
      capacityReason: "tier 0: only 0.4 GB free (floor 2GB)",
      floorEnabled: true,
    });
    expect(a.admit).toBe(false);
    if (a.admit) throw new Error("unreachable");
    expect(a.reason).toBe("host_saturated");
    // The operator has to be able to tell WHY without reading the source.
    expect(a.detail).toContain("0.4 GB free");
  });

  it("admits when an operator has turned the floor off, even on a saturated box", () => {
    const a = decideGateHostAdmission({ capacityHold: true, capacityReason: "tight", floorEnabled: false });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe("floor_disabled");
  });

  /**
   * The whole guard is FAIL-OPEN, mirroring #1009: `readTier0Capacity` returns `hold: false`
   * when it cannot sample memory, so an unmeasurable box behaves exactly as it does today
   * rather than refusing every merge on this machine.
   */
  it("admits when capacity could not be measured (fail-open, never fail-closed)", () => {
    const a = decideGateHostAdmission({ capacityHold: false, capacityReason: "unreadable", floorEnabled: true });
    expect(a.admit).toBe(true);
  });
});

/**
 * #1056 — `%TEMP%` exhaustion is a SECOND way the same box is unfit, and one CPU and memory
 * cannot see. The three runs #1057's header attributes to saturation were reproduced on an
 * IDLE box (CPU 18 %, 4.9 GB usable) and failed identically; the `%TEMP%` the runner writes
 * into held 707,242 entries, at which size a bare enumeration exceeded 120s.
 */
describe("gate temp-health admission (#1056)", () => {
  const healthy = { capacityHold: false, capacityReason: "4.0 GB free", floorEnabled: true };

  it("refuses a gate when %TEMP% is degraded, and carries the measured reason", () => {
    const a = decideGateHostAdmission({
      ...healthy,
      tempDegraded: true,
      tempReason: "C:\Temp holds at least 50000 entries (cap 50000)",
    });
    expect(a.admit).toBe(false);
    if (a.admit) throw new Error("unreachable");
    expect(a.reason).toBe("temp_exhausted");
    expect(a.detail).toContain("50000 entries");
    // A hold nobody can act on is a hold nobody will act on.
    expect(a.detail).toContain("sweep-loose-test-db-files.mjs");
  });

  it("reports a box that is BOTH saturated and temp-exhausted as saturated", () => {
    // Deliberate: capacity is the cheaper signal and the more common cause, and it is the one
    // an operator can act on immediately. Two holds reported as one must pick, and pick stably.
    const a = decideGateHostAdmission({
      capacityHold: true,
      capacityReason: "only 0.4 GB free",
      floorEnabled: true,
      tempDegraded: true,
      tempReason: "temp is huge",
    });
    expect(a.admit).toBe(false);
    if (a.admit) throw new Error("unreachable");
    expect(a.reason).toBe("host_saturated");
  });

  it("the operator floor switch turns BOTH holds off, not just the capacity one", () => {
    // `gate_host_floor_<id>=false` is documented as "run the gate anyway". A second hold that
    // ignored it would make the escape hatch silently stop working.
    const a = decideGateHostAdmission({
      ...healthy,
      floorEnabled: false,
      tempDegraded: true,
      tempReason: "temp is huge",
    });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe("floor_disabled");
  });

  it("a caller that does not probe temp at all behaves exactly as before", () => {
    // The fields are optional so #1057's call shape keeps its meaning byte for byte.
    const a = decideGateHostAdmission(healthy);
    expect(a.admit).toBe(true);
    expect(a.reason).toBe("host_has_room");
  });
});
