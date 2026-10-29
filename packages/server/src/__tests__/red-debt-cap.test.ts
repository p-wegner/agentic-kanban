import { describe, it, expect } from "vitest";
import {
  resolveEffectiveRedBasePolicy,
  redDebtMaxPrefKey,
  redDebtMaxAgePrefKey,
  DEFAULT_RED_DEBT_MAX_ENTRIES,
  DEFAULT_RED_DEBT_MAX_AGE_MS,
} from "../lib/red-debt-cap.js";

describe("redDebtMaxPrefKey / redDebtMaxAgePrefKey", () => {
  it("builds the per-project keys", () => {
    expect(redDebtMaxPrefKey("p1")).toBe("red_debt_max_p1");
    expect(redDebtMaxAgePrefKey("p1")).toBe("red_debt_max_age_p1");
  });
});

describe("resolveEffectiveRedBasePolicy — the cap on the red-base policy", () => {
  it("never degrades `block`", () => {
    const r = resolveEffectiveRedBasePolicy({ policy: "block", openEntryCount: 9999, oldestOpenEntryAgeMs: null });
    expect(r).toEqual({ effectivePolicy: "block", degraded: false, note: null });
  });

  it("stays put under the default caps", () => {
    const r = resolveEffectiveRedBasePolicy({
      policy: "allow-known-debt", openEntryCount: DEFAULT_RED_DEBT_MAX_ENTRIES, oldestOpenEntryAgeMs: DEFAULT_RED_DEBT_MAX_AGE_MS - 1,
    });
    expect(r.degraded).toBe(false);
  });

  it("steps all the way to `block` over the entry-count cap, and says why", () => {
    const r = resolveEffectiveRedBasePolicy({ policy: "report", openEntryCount: DEFAULT_RED_DEBT_MAX_ENTRIES + 1, oldestOpenEntryAgeMs: 0 });
    expect(r.effectivePolicy).toBe("block");
    expect(r.note).toContain("red-debt cap exceeded");
  });

  it("degrades over the age cap", () => {
    const r = resolveEffectiveRedBasePolicy({ policy: "allow-known-debt", openEntryCount: 0, oldestOpenEntryAgeMs: DEFAULT_RED_DEBT_MAX_AGE_MS + 1 });
    expect(r.effectivePolicy).toBe("block");
  });

  it("honours per-project overrides; 0 or garbage means the default", () => {
    expect(resolveEffectiveRedBasePolicy({ policy: "allow-known-debt", openEntryCount: 3, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "2" }).degraded).toBe(true);
    expect(resolveEffectiveRedBasePolicy({ policy: "allow-known-debt", openEntryCount: 3, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "10" }).degraded).toBe(false);
    expect(resolveEffectiveRedBasePolicy({ policy: "allow-known-debt", openEntryCount: 1, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "0" }).degraded).toBe(false);
    expect(resolveEffectiveRedBasePolicy({ policy: "allow-known-debt", openEntryCount: 1, oldestOpenEntryAgeMs: 0, maxEntriesRaw: "x" }).degraded).toBe(false);
  });
});
