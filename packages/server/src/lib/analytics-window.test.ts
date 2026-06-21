import { describe, it, expect } from "vitest";
import { clampDays, subDays, cutoffDayFor, buildDateAxis } from "./analytics-window.js";

// Pinned to noon UTC so toISOString()-derived day strings are stable regardless
// of the test runner's local timezone (a ±12h offset at noon never flips the day).
const NOW = new Date("2026-06-21T12:00:00.000Z");
const at = (day: string) => `${day}T12:00:00.000Z`;

describe("clampDays", () => {
  it("falls back when the param is missing", () => {
    expect(clampDays(undefined, 30)).toBe(30);
    expect(clampDays(undefined, 14)).toBe(14);
  });
  it("parses a valid integer", () => {
    expect(clampDays("14", 30)).toBe(14);
  });
  it("falls back on a non-numeric param", () => {
    expect(clampDays("abc", 30)).toBe(30);
  });
  it("clamps to [1, 365]", () => {
    expect(clampDays("0", 30)).toBe(1);
    expect(clampDays("-5", 14)).toBe(1);
    expect(clampDays("9999", 30)).toBe(365);
  });
});

describe("subDays", () => {
  it("returns a fresh Date n calendar days before now without mutating now", () => {
    const before = NOW.getTime();
    expect(subDays(NOW, 6).toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(subDays(NOW, 0).toISOString().slice(0, 10)).toBe("2026-06-21");
    expect(NOW.getTime()).toBe(before); // unmutated
  });
});

describe("cutoffDayFor", () => {
  it("is days-1 calendar days before now (window includes today)", () => {
    expect(cutoffDayFor(NOW, 7)).toBe("2026-06-15");
    expect(cutoffDayFor(NOW, 1)).toBe("2026-06-21");
  });
});

describe("buildDateAxis", () => {
  it("is inclusive of both endpoints, one entry per day", () => {
    expect(buildDateAxis(new Date(at("2026-06-19")), new Date(at("2026-06-21")))).toEqual([
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ]);
  });
  it("is a single day when start === end", () => {
    expect(buildDateAxis(new Date(at("2026-06-21")), new Date(at("2026-06-21")))).toEqual([
      "2026-06-21",
    ]);
  });
  it("is empty when start is after end", () => {
    expect(buildDateAxis(new Date(at("2026-06-22")), new Date(at("2026-06-21")))).toEqual([]);
  });
});
