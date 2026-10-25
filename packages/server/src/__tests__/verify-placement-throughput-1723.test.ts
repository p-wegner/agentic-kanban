import { describe, expect, it } from "vitest";
import { decideVerifyPlacement } from "../services/verify-placement.js";

const MIN = 60_000;
const allow = new Set(["fast", "slow"]);
const decide = (workers: Parameters<typeof decideVerifyPlacement>[0]["workers"]) =>
  decideVerifyPlacement({ placement: "worker", kind: "rc-sweep", hostHeld: false, allowlist: allow, workers });

describe("verify placement prefers measured throughput (#1723)", () => {
  it("sends a sweep to the 30-min worker even with fewer free slots", () => {
    const d = decide([
      { id: "slow", name: "slow", freeSlots: 4, freeRamGb: 30, expectedMs: { "rc-sweep": 70 * MIN } },
      { id: "fast", name: "fast", freeSlots: 1, freeRamGb: 10, expectedMs: { "rc-sweep": 30 * MIN } },
    ]);
    expect(d).toMatchObject({ target: "worker", workerName: "fast" });
    expect(d.reason).toContain("expected 30 min vs slow 70 min");
  });
  it("falls back to the existing order without history", () => {
    const d = decide([
      { id: "slow", name: "slow", freeSlots: 4, freeRamGb: 30 },
      { id: "fast", name: "fast", freeSlots: 1, freeRamGb: 10 },
    ]);
    expect(d).toMatchObject({ workerName: "slow" });
  });
});
