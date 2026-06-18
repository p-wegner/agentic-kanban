import { describe, it, expect } from "vitest";
import {
  contextWindowForModel,
  occupancyFromStatsJson,
  occupancyFromLive,
  occupancyColor,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-window.js";

describe("contextWindowForModel", () => {
  it("defaults to 200k for unknown / legacy claude models", () => {
    expect(contextWindowForModel(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("some-unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    // Haiku and pre-4.6 Opus/Sonnet stay at 200k.
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowForModel("claude-opus-4-5")).toBe(200_000);
    expect(contextWindowForModel("claude-sonnet-4-5")).toBe(200_000);
  });

  it("recognizes 1M-context claude variants", () => {
    // Explicit [1m] / -1m suffixes.
    expect(contextWindowForModel("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-4-1m")).toBe(1_000_000);
    // Modern Opus/Sonnet families are 1M even without a suffix — the bug was
    // these reporting 200k. (#843)
    expect(contextWindowForModel("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-4-6")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(1_000_000);
    expect(contextWindowForModel("claude-fable-5")).toBe(1_000_000);
  });

  it("maps gpt-5 / codex / o-series to 400k", () => {
    expect(contextWindowForModel("gpt-5.5")).toBe(400_000);
    expect(contextWindowForModel("gpt-5.3-codex")).toBe(400_000);
    expect(contextWindowForModel("o3-mini")).toBe(400_000);
  });

  it("maps gemini to 1M", () => {
    expect(contextWindowForModel("gemini-2.5-pro")).toBe(1_000_000);
  });
});

describe("occupancyFromStatsJson", () => {
  it("returns null for empty / malformed input", () => {
    expect(occupancyFromStatsJson(null)).toBeNull();
    expect(occupancyFromStatsJson("not json")).toBeNull();
    expect(occupancyFromStatsJson("{}")).toBeNull();
  });

  it("prefers explicit contextTokens when present", () => {
    const occ = occupancyFromStatsJson(
      JSON.stringify({ contextTokens: 50_000, inputTokens: 1, cacheReadTokens: 1, model: "claude-haiku-4-5" }),
    );
    expect(occ?.contextTokens).toBe(50_000);
    expect(occ?.contextWindow).toBe(200_000);
    expect(occ?.fraction).toBeCloseTo(0.25);
  });

  it("falls back to inputTokens + cacheReadTokens", () => {
    const occ = occupancyFromStatsJson(
      JSON.stringify({ inputTokens: 30_000, cacheReadTokens: 20_000, outputTokens: 5_000, model: "claude-haiku-4-5" }),
    );
    expect(occ?.contextTokens).toBe(50_000);
    expect(occ?.outputTokens).toBe(5_000);
  });

  it("returns null when occupancy is zero", () => {
    expect(occupancyFromStatsJson(JSON.stringify({ inputTokens: 0, cacheReadTokens: 0 }))).toBeNull();
  });

  it("clamps fraction to [0,1] when over the window", () => {
    const occ = occupancyFromStatsJson(JSON.stringify({ contextTokens: 500_000, model: "claude-haiku-4-5" }));
    expect(occ?.fraction).toBe(1);
  });

  it("uses the 1M window for modern Opus/Sonnet models (#843)", () => {
    const occ = occupancyFromStatsJson(JSON.stringify({ contextTokens: 250_000, model: "claude-opus-4-8" }));
    expect(occ?.contextWindow).toBe(1_000_000);
    expect(occ?.fraction).toBeCloseTo(0.25);
  });
});

describe("occupancyFromLive", () => {
  it("builds occupancy from live context tokens", () => {
    const occ = occupancyFromLive(140_000, "claude-haiku-4-5");
    expect(occ?.contextTokens).toBe(140_000);
    expect(occ?.fraction).toBeCloseTo(0.7);
  });

  it("returns null for zero tokens", () => {
    expect(occupancyFromLive(0, "claude-opus-4-8")).toBeNull();
  });
});

describe("occupancyColor", () => {
  it("escalates green → amber → red", () => {
    expect(occupancyColor(0.1).bar).toContain("brand");
    expect(occupancyColor(0.75).bar).toContain("amber");
    expect(occupancyColor(0.95).bar).toContain("red");
  });
});
