import { describe, it, expect } from "vitest";
import {
  parseBoardHealthEventsLimit,
  parseBoardHealthEventTypes,
  parseBoardHealthCategories,
  compactBoardHealthEventDetails,
} from "./board-health-events-format.js";

describe("parseBoardHealthEventsLimit", () => {
  it("defaults to 20 for missing/invalid input", () => {
    expect(parseBoardHealthEventsLimit(undefined)).toBe(20);
    expect(parseBoardHealthEventsLimit("")).toBe(20);
    expect(parseBoardHealthEventsLimit("abc")).toBe(20);
  });

  it("clamps to [1, 50]", () => {
    expect(parseBoardHealthEventsLimit("0")).toBe(1);
    expect(parseBoardHealthEventsLimit("-5")).toBe(1);
    expect(parseBoardHealthEventsLimit("1000")).toBe(50);
    expect(parseBoardHealthEventsLimit("33")).toBe(33);
  });
});

describe("parseBoardHealthEventTypes", () => {
  it("returns undefined for empty or all-invalid input", () => {
    expect(parseBoardHealthEventTypes(undefined)).toBeUndefined();
    expect(parseBoardHealthEventTypes("")).toBeUndefined();
    expect(parseBoardHealthEventTypes("bogus,nope")).toBeUndefined();
  });

  it("keeps only valid types and trims whitespace", () => {
    expect(parseBoardHealthEventTypes(" action , error , bogus ")).toEqual(["action", "error"]);
  });
});

describe("parseBoardHealthCategories", () => {
  it("keeps only valid categories", () => {
    expect(parseBoardHealthCategories("merge,launch,bogus")).toEqual(["merge", "launch"]);
    expect(parseBoardHealthCategories("nope")).toBeUndefined();
  });
});

describe("compactBoardHealthEventDetails", () => {
  it("returns null for empty / null-ish JSON", () => {
    expect(compactBoardHealthEventDetails(null)).toBeNull();
    expect(compactBoardHealthEventDetails("")).toBeNull();
    expect(compactBoardHealthEventDetails("null")).toBeNull();
    expect(compactBoardHealthEventDetails("{}")).toBeNull();
  });

  it("renders scalars and arrays", () => {
    expect(compactBoardHealthEventDetails("42")).toBe("42");
    expect(compactBoardHealthEventDetails('"hi"')).toBe("hi");
    expect(compactBoardHealthEventDetails("[1,2,3]")).toBe("3 items");
    expect(compactBoardHealthEventDetails("[1]")).toBe("1 item");
  });

  it("summarizes object fields, skipping null/undefined and capping at 4", () => {
    expect(compactBoardHealthEventDetails(JSON.stringify({ a: 1, b: "x", c: null }))).toBe("a: 1, b: x");
    expect(
      compactBoardHealthEventDetails(JSON.stringify({ items: [1, 2], meta: { x: 1, y: 2 } })),
    ).toBe("items: 2 items, meta: 2 fields");
    const summary = compactBoardHealthEventDetails(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }));
    expect(summary).toBe("a: 1, b: 2, c: 3, d: 4"); // capped at first 4
  });

  it("falls back to a 160-char slice of non-JSON input", () => {
    const raw = "x".repeat(200);
    expect(compactBoardHealthEventDetails(raw)).toBe("x".repeat(160));
  });
});
