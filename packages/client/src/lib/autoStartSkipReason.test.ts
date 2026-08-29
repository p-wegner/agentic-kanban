import { describe, it, expect } from "vitest";
import { describeAutoStartSkipReason } from "./autoStartSkipReason.js";

describe("describeAutoStartSkipReason (#919)", () => {
  it("renders nothing when the monitor has never declined this ticket", () => {
    expect(describeAutoStartSkipReason(null)).toBeNull();
    expect(describeAutoStartSkipReason(undefined)).toBeNull();
    expect(describeAutoStartSkipReason("")).toBeNull();
  });

  it("names the three reasons the acceptance criterion calls out, as capacity HOLDS", () => {
    for (const reason of ["wip_cap", "machine_saturated", "contention_gate"]) {
      const d = describeAutoStartSkipReason(reason);
      expect(d).not.toBeNull();
      expect(d!.kind).toBe("hold");
      // A token is not an answer — the tooltip has to say what to do about it.
      expect(d!.label).not.toBe(reason);
      expect(d!.detail.length).toBeGreaterThan(20);
    }
  });

  it("distinguishes a capacity hold from a decision not to start this ticket at all", () => {
    expect(describeAutoStartSkipReason("no_auto_start_tag")!.kind).toBe("decline");
    expect(describeAutoStartSkipReason("wip_cap")!.kind).toBe("hold");
  });

  it("renders an unknown token verbatim rather than dropping it", () => {
    // The server's vocabulary can grow ahead of a client build; showing an unfamiliar
    // reason beats showing none, which would read as 'no reason recorded'.
    const d = describeAutoStartSkipReason("some_future_reason");
    expect(d).not.toBeNull();
    expect(d!.label).toBe("some_future_reason");
    expect(d!.detail).toContain("some_future_reason");
  });
});
