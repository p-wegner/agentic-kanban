import { describe, it, expect } from "vitest";
import { extractJsonArray, coerceRecommendation } from "../services/agent-questions.service.js";

describe("extractJsonArray", () => {
  it("parses a plain JSON array", () => {
    const r = extractJsonArray('[{"recommendedOptionIndexes":[0],"rationale":"x"}]');
    expect(Array.isArray(r)).toBe(true);
  });

  it("strips ```json fences", () => {
    const r = extractJsonArray('```json\n[{"a":1}]\n```');
    expect(r).toEqual([{ a: 1 }]);
  });

  it("strips bare ``` fences", () => {
    const r = extractJsonArray('```\n[1,2,3]\n```');
    expect(r).toEqual([1, 2, 3]);
  });

  it("tolerates leading prose", () => {
    const r = extractJsonArray('Sure! Here you go: [{"x":1}] cheers');
    expect(r).toEqual([{ x: 1 }]);
  });

  it("throws on empty input", () => {
    expect(() => extractJsonArray("")).toThrow();
  });

  it("throws when no array is present", () => {
    expect(() => extractJsonArray("nope, no JSON here")).toThrow();
  });
});

describe("coerceRecommendation", () => {
  it("returns null for non-objects", () => {
    expect(coerceRecommendation(null, 3, false)).toBe(null);
    expect(coerceRecommendation("string", 3, false)).toBe(null);
  });

  it("clamps single-select to one index", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 1], rationale: "pick first" },
      3,
      false,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0]);
  });

  it("keeps multiple indexes for multi-select", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 2], rationale: "both" },
      3,
      true,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0, 2]);
  });

  it("filters out-of-range indexes", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 5, -1, 2], rationale: "x" },
      3,
      true,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0, 2]);
  });

  it("accepts freeText alone", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [], freeText: "something else", rationale: "no fit" },
      3,
      false,
    );
    expect(r?.recommendedOptionIndexes).toEqual([]);
    expect(r?.freeText).toBe("something else");
  });

  it("truncates very long rationales", () => {
    const long = "x".repeat(500);
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0], rationale: long },
      2,
      false,
    );
    expect((r?.rationale.length ?? 0)).toBeLessThanOrEqual(240);
  });

  it("returns null when there's nothing usable", () => {
    expect(coerceRecommendation({ recommendedOptionIndexes: [99] }, 2, false)).toBe(null);
  });
});
