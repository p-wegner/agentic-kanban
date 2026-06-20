import { describe, it, expect } from "vitest";
import {
  parseStatsBlob,
  projectSessionStats,
  computeSessionDuration,
} from "../lib/issue-summary-projection.js";

describe("parseStatsBlob", () => {
  it("returns null for null/empty/malformed/non-object", () => {
    expect(parseStatsBlob(null)).toBeNull();
    expect(parseStatsBlob("")).toBeNull();
    expect(parseStatsBlob("{bad")).toBeNull();
    expect(parseStatsBlob("42")).toBeNull();
    expect(parseStatsBlob("null")).toBeNull();
  });

  it("parses a valid object", () => {
    expect(parseStatsBlob('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("projectSessionStats", () => {
  it("returns null when there is no stats blob", () => {
    expect(projectSessionStats(null, "m")).toBeNull();
  });

  it("applies historical defaults (numTurns 1, others 0/false)", () => {
    expect(projectSessionStats({}, null)).toEqual({
      durationMs: 0,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 1,
      model: null,
      success: false,
    });
  });

  it("passes through provided numeric/boolean fields", () => {
    expect(
      projectSessionStats(
        { durationMs: 1500, totalCostUsd: 0.02, inputTokens: 100, outputTokens: 50, numTurns: 3, success: true },
        null,
      ),
    ).toMatchObject({ durationMs: 1500, totalCostUsd: 0.02, inputTokens: 100, outputTokens: 50, numTurns: 3, success: true });
  });

  it("prefers the blob model, falling back to the summary model", () => {
    expect(projectSessionStats({ model: "opus" }, "sonnet").model).toBe("opus");
    expect(projectSessionStats({}, "sonnet").model).toBe("sonnet");
  });

  it("coerces a non-number field to its default", () => {
    expect(projectSessionStats({ inputTokens: "oops" as unknown }, null).inputTokens).toBe(0);
  });
});

describe("computeSessionDuration", () => {
  it("returns null when either timestamp is missing", () => {
    expect(computeSessionDuration(null, "2026-01-01T00:00:01Z")).toBeNull();
    expect(computeSessionDuration("2026-01-01T00:00:00Z", null)).toBeNull();
  });

  it("formats a positive elapsed time", () => {
    const out = computeSessionDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z");
    expect(typeof out).toBe("string");
    expect(out).toBeTruthy();
  });
});
