import { describe, it, expect } from "vitest";
import { deriveVerifySlots } from "../worker/worker-verify-runner.js";

describe("deriveVerifySlots (#1496)", () => {
  it("scales with RAM and cores, between 1 and 3", () => {
    expect(deriveVerifySlots(8, 8)).toBe(1);
    expect(deriveVerifySlots(44, 16)).toBe(2);
    expect(deriveVerifySlots(64, 24)).toBe(3);
    expect(deriveVerifySlots(256, 64)).toBe(3);
    expect(deriveVerifySlots(64, 4)).toBe(1);
  });
});
