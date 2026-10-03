import { describe, expect, it } from "vitest";
import { adaptiveVerifyTimeoutMs, DEFAULT_VERIFY_TIMEOUT_MS } from "../services/verify-tunables.js";
import { probeMaxDurationMs, PROBE_MAX_DURATION_MS } from "../services/base-branch-health.service.js";

const MIN = 60 * 1000;

/**
 * The verify budget follows the suite (2026-10-02): four full sweeps in a row timed out at the
 * fixed 45 minutes while the suite needed ~47, so the promote could never get a verdict.
 */
describe("adaptive verify budget", () => {
  it("never drops below the shared default", () => {
    expect(adaptiveVerifyTimeoutMs([])).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
    expect(adaptiveVerifyTimeoutMs([10 * MIN, 20 * MIN])).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it("widens to 1.5x the longest recent probe, timeouts included", () => {
    // The measured case: a 2779s timeout must buy the next run more than 45 minutes.
    expect(adaptiveVerifyTimeoutMs([2_046_000, 2_779_000])).toBe(Math.ceil(2_779_000 * 1.5));
    expect(adaptiveVerifyTimeoutMs([2_779_000])).toBeGreaterThan(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it("is capped at 3 hours and ignores unusable durations", () => {
    expect(adaptiveVerifyTimeoutMs([10 * 60 * MIN])).toBe(3 * 60 * MIN);
    expect(adaptiveVerifyTimeoutMs([Number.NaN, -1])).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it("the probe's in-flight expiry follows the resolved budget", () => {
    expect(probeMaxDurationMs(DEFAULT_VERIFY_TIMEOUT_MS)).toBe(PROBE_MAX_DURATION_MS);
    expect(probeMaxDurationMs(90 * MIN) - PROBE_MAX_DURATION_MS).toBe(45 * MIN);
  });
});
