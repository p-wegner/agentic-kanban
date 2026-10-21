import { describe, expect, it } from "vitest";
import { intervalSecFor, pollDurationForBackoff, POLL_TIMEOUT_MS } from "../cli/commands/status.js";

describe("status console backoff cap (#1676)", () => {
  it("caps a 3 h poll at 5x the base interval, not 6 h", () => {
    expect(intervalSecFor(60, 3 * 3600 * 1000)).toBe(300);
    expect(intervalSecFor(5, 3 * 3600 * 1000)).toBe(25);
  });

  it("still doubles a moderately slow answer and never goes below base", () => {
    expect(intervalSecFor(60, 40_000)).toBe(80);
    expect(intervalSecFor(60, 1_000)).toBe(60);
  });

  it("a timed-out poll counts as the timeout, so the next wait stays within the cap", () => {
    const counted = pollDurationForBackoff(917_960);
    expect(counted).toBe(POLL_TIMEOUT_MS);
    expect(intervalSecFor(60, counted)).toBeLessThanOrEqual(300);
  });
});
