// #340: the /stats metrics cache used to be keyed on the resolved HEAD sha and to
// refuse to cache at all when `git rev-parse` failed. Since rev-parse only times out
// when the machine is already loaded, the cache AND the in-flight dedupe switched
// themselves off exactly under the load that made them necessary, and every concurrent
// request started its own full 6000-file walk (the measured 132-509s, 4-deep pile-up).
// HEAD is now an invalidation input rather than part of the key. These are the rules.
import { describe, it, expect } from "vitest";
import { isMetricsEntryUsable, metricsCacheKey } from "../lib/metrics-cache-policy.js";

const TTL = 60_000;
const NOW = 1_700_000_000_000;

describe("metricsCacheKey", () => {
  it("depends only on repo and branch, so a resolvable and an unresolvable HEAD cannot split the entry", () => {
    // This is the property that matters: the sync and async paths race, and whichever
    // one's rev-parse times out must still land on the SAME entry as the other.
    expect(metricsCacheKey("/repo", "main")).toBe(metricsCacheKey("/repo", "main"));
    expect(metricsCacheKey("/repo", "main")).not.toBe(metricsCacheKey("/repo", "develop"));
    expect(metricsCacheKey("/repo", "main")).not.toBe(metricsCacheKey("/other", "main"));
  });
});

describe("isMetricsEntryUsable", () => {
  it("is unusable when there is no entry at all (true first sighting pays the walk)", () => {
    expect(isMetricsEntryUsable(undefined, "sha1", TTL, NOW)).toBe(false);
  });

  it("serves a fresh entry computed at the same HEAD", () => {
    expect(isMetricsEntryUsable({ timestamp: NOW - 1_000, head: "sha1" }, "sha1", TTL, NOW)).toBe(true);
  });

  it("invalidates when HEAD has advanced — a new commit is still picked up immediately", () => {
    expect(isMetricsEntryUsable({ timestamp: NOW - 1_000, head: "sha1" }, "sha2", TTL, NOW)).toBe(false);
  });

  it("invalidates on TTL expiry even at the same HEAD", () => {
    expect(isMetricsEntryUsable({ timestamp: NOW - TTL, head: "sha1" }, "sha1", TTL, NOW)).toBe(false);
    expect(isMetricsEntryUsable({ timestamp: NOW - TTL - 1, head: "sha1" }, "sha1", TTL, NOW)).toBe(false);
  });

  it("serves a fresh entry when HEAD is UNRESOLVABLE — the whole point of #340", () => {
    // An unresolved head tells us nothing about staleness, and a blob at most one TTL
    // old beats an uncached multi-minute recompute under exactly this load.
    expect(isMetricsEntryUsable({ timestamp: NOW - 1_000, head: "sha1" }, null, TTL, NOW)).toBe(true);
    expect(isMetricsEntryUsable({ timestamp: NOW - 1_000, head: null }, null, TTL, NOW)).toBe(true);
  });

  it("does not resurrect an expired entry just because HEAD is unresolvable", () => {
    expect(isMetricsEntryUsable({ timestamp: NOW - TTL, head: "sha1" }, null, TTL, NOW)).toBe(false);
  });

  it("serves an entry with an unknown stored HEAD against any resolved HEAD", () => {
    // Computed during a load window where rev-parse failed; still the best value we have.
    expect(isMetricsEntryUsable({ timestamp: NOW - 1_000, head: null }, "sha9", TTL, NOW)).toBe(true);
  });
});
