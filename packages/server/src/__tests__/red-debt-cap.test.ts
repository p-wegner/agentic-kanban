import { describe, it, expect } from "vitest";
import {
  resolveRedDebtCapDegrade,
  resolveEffectiveRedDebtPosture,
  redDebtMaxPrefKey,
  redDebtMaxAgePrefKey,
  DEFAULT_RED_DEBT_MAX_ENTRIES,
  DEFAULT_RED_DEBT_MAX_AGE_MS,
} from "../lib/red-debt-cap.js";

describe("redDebtMaxPrefKey / redDebtMaxAgePrefKey", () => {
  it("builds the per-project keys", () => {
    expect(redDebtMaxPrefKey("proj-1")).toBe("red_debt_max_proj-1");
    expect(redDebtMaxAgePrefKey("proj-1")).toBe("red_debt_max_age_proj-1");
  });
});

describe("resolveRedDebtCapDegrade — the profile-allowlist-hold shape, applied to a downgrade", () => {
  it("never evaluates strict/standard — nothing to degrade", () => {
    for (const posture of ["strict", "standard"] as const) {
      const result = resolveRedDebtCapDegrade({ posture, openEntryCount: 9999, oldestOpenEntryAgeMs: 9999 * 24 * 60 * 60 * 1000 });
      expect(result).toEqual({ effectivePosture: posture, degraded: false, note: null });
    }
  });

  it("stays at sprint under the default caps", () => {
    const result = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: DEFAULT_RED_DEBT_MAX_ENTRIES, oldestOpenEntryAgeMs: DEFAULT_RED_DEBT_MAX_AGE_MS - 1 });
    expect(result.degraded).toBe(false);
    expect(result.effectivePosture).toBe("sprint");
  });

  it("degrades sprint -> fast when the entry-count cap is exceeded, and says why", () => {
    const result = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: DEFAULT_RED_DEBT_MAX_ENTRIES + 1, oldestOpenEntryAgeMs: 0 });
    expect(result.degraded).toBe(true);
    expect(result.effectivePosture).toBe("fast");
    expect(result.note).toContain("exceed the cap");
  });

  it("degrades fast -> standard when the age cap is exceeded", () => {
    const result = resolveRedDebtCapDegrade({ posture: "fast", openEntryCount: 0, oldestOpenEntryAgeMs: DEFAULT_RED_DEBT_MAX_AGE_MS + 1 });
    expect(result.degraded).toBe(true);
    expect(result.effectivePosture).toBe("standard");
    expect(result.note).toContain("exceeding the");
  });

  it("never silent when degraded — note is always populated", () => {
    const result = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: 999, oldestOpenEntryAgeMs: null });
    expect(result.degraded).toBe(true);
    expect(result.note).toBeTruthy();
  });

  it("honours per-project overrides", () => {
    const stillOk = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: 3, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "2" });
    expect(stillOk.degraded).toBe(true);
    const withinCustomCap = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: 3, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "10" });
    expect(withinCustomCap.degraded).toBe(false);
  });

  it("treats a cap of 0 or a garbage value as 'use the default', not 'degrade immediately'", () => {
    const result = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: 1, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "0" });
    expect(result.degraded).toBe(false);
    const garbage = resolveRedDebtCapDegrade({ posture: "sprint", openEntryCount: 1, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "not-a-number" });
    expect(garbage.degraded).toBe(false);
  });
});

describe("resolveEffectiveRedDebtPosture — walks the degrade chain to its resting point", () => {
  it("sprint with BOTH caps blown degrades straight to standard, in one resolved call", () => {
    const result = resolveEffectiveRedDebtPosture({
      posture: "sprint",
      openEntryCount: DEFAULT_RED_DEBT_MAX_ENTRIES + 1,
      oldestOpenEntryAgeMs: DEFAULT_RED_DEBT_MAX_AGE_MS + 1,
    });
    expect(result.effectivePosture).toBe("standard");
    expect(result.degraded).toBe(true);
    expect(result.note).toContain("sprint -> fast");
    expect(result.note).toContain("fast -> standard");
  });

  it("is a no-op when within caps", () => {
    const result = resolveEffectiveRedDebtPosture({ posture: "sprint", openEntryCount: 0, oldestOpenEntryAgeMs: null });
    expect(result).toEqual({ effectivePosture: "sprint", degraded: false, note: null });
  });
});
