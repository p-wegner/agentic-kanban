import { describe, expect, it } from "vitest";
import { USAGE_LIMIT_WINDOW_MS, usageLimitHoldsUntil } from "./usage-limit-cooldown.js";

const nowMs = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

describe("usageLimitHoldsUntil (#1452)", () => {
  it("a months-old session owes no cooldown", () => {
    expect(usageLimitHoldsUntil({ retryAfter: null, endedAt: iso(nowMs - 60 * 86_400_000), nowMs })).toBeNull();
  });
  it("a reset time already in the past owes no cooldown", () => {
    expect(usageLimitHoldsUntil({ retryAfter: iso(nowMs - 1000), endedAt: iso(nowMs - 2 * USAGE_LIMIT_WINDOW_MS), nowMs })).toBeNull();
  });
  it("anchors the fallback window on the session end, not now", () => {
    const ended = nowMs - 3_600_000;
    expect(usageLimitHoldsUntil({ retryAfter: null, endedAt: iso(ended), nowMs })).toBe(iso(ended + USAGE_LIMIT_WINDOW_MS));
  });
  it("honours a future reset time the session reported (epoch seconds too)", () => {
    const reset = nowMs + 600_000;
    expect(usageLimitHoldsUntil({ retryAfter: iso(reset), endedAt: iso(nowMs), nowMs })).toBe(iso(reset));
    expect(usageLimitHoldsUntil({ retryAfter: String(Math.floor(reset / 1000)), endedAt: iso(nowMs), nowMs })).toBe(iso(Math.floor(reset / 1000) * 1000));
  });
  it("a live exit with no end time falls back to now + window", () => {
    expect(usageLimitHoldsUntil({ retryAfter: null, endedAt: null, nowMs })).toBe(iso(nowMs + USAGE_LIMIT_WINDOW_MS));
  });
});
