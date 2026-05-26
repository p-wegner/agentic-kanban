import { describe, expect, it } from "vitest";
import { isAnalyticsNoise, NOISE_TRIGGER_TYPES } from "../services/session-filter.js";

describe("isAnalyticsNoise", () => {
  it("returns false for null triggerType (regular agent sessions)", () => {
    expect(isAnalyticsNoise({ triggerType: null })).toBe(false);
  });

  it("returns false for undefined triggerType", () => {
    expect(isAnalyticsNoise({})).toBe(false);
  });

  it("returns false for regular agent sessions", () => {
    expect(isAnalyticsNoise({ triggerType: "agent" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "chat" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "review" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "verify" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "learning" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "plan-implement" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "fix-conflicts" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "fix-and-merge" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "auto-start" })).toBe(false);
    expect(isAnalyticsNoise({ triggerType: "skill:code-review" })).toBe(false);
  });

  it("returns true for board-monitor sessions", () => {
    expect(isAnalyticsNoise({ triggerType: "skill:board-monitor" })).toBe(true);
  });

  it("returns true for board-navigator sessions", () => {
    expect(isAnalyticsNoise({ triggerType: "skill:board-navigator" })).toBe(true);
  });

  it("NOISE_TRIGGER_TYPES lists all noise types", () => {
    expect(NOISE_TRIGGER_TYPES).toContain("skill:board-monitor");
    expect(NOISE_TRIGGER_TYPES).toContain("skill:board-navigator");
  });
});
