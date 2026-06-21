import { describe, it, expect } from "vitest";
import { validateAgingThreshold } from "./agingHeatmapThresholds.js";

describe("validateAgingThreshold", () => {
  it("warm is valid when 1 <= v < hotDays", () => {
    expect(validateAgingThreshold("3", { which: "warm", warmDays: 2, hotDays: 7 })).toEqual({ valid: true, value: 3 });
    expect(validateAgingThreshold("7", { which: "warm", warmDays: 2, hotDays: 7 }).valid).toBe(false); // not < hotDays
    expect(validateAgingThreshold("0", { which: "warm", warmDays: 2, hotDays: 7 }).valid).toBe(false); // < 1
  });

  it("hot is valid when v > warmDays", () => {
    expect(validateAgingThreshold("10", { which: "hot", warmDays: 3, hotDays: 7 })).toEqual({ valid: true, value: 10 });
    expect(validateAgingThreshold("3", { which: "hot", warmDays: 3, hotDays: 7 }).valid).toBe(false); // not > warmDays
  });

  it("non-numeric input is invalid", () => {
    expect(validateAgingThreshold("abc", { which: "warm", warmDays: 2, hotDays: 7 }).valid).toBe(false);
    expect(validateAgingThreshold("", { which: "hot", warmDays: 2, hotDays: 7 }).valid).toBe(false);
  });
});
