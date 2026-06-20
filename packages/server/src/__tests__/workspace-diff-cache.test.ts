import { describe, it, expect } from "vitest";
import {
  selectCachedDiffStats,
  isPlanOnlySession,
  isDiffCacheStale,
  type DiffStatCacheFields,
} from "../lib/workspace-diff-cache.js";

function cache(over: Partial<DiffStatCacheFields> = {}): DiffStatCacheFields {
  return {
    diffStatCacheCheckedAt: over.diffStatCacheCheckedAt ?? null,
    diffStatCacheFilesChanged: over.diffStatCacheFilesChanged ?? null,
    diffStatCacheInsertions: over.diffStatCacheInsertions ?? null,
    diffStatCacheDeletions: over.diffStatCacheDeletions ?? null,
    diffStatCacheHeadSha: over.diffStatCacheHeadSha ?? null,
  };
}

describe("selectCachedDiffStats", () => {
  it("returns null when never checked", () => {
    expect(selectCachedDiffStats(cache({ diffStatCacheFilesChanged: 3 }))).toBeNull();
  });

  it("returns null when filesChanged is null", () => {
    expect(selectCachedDiffStats(cache({ diffStatCacheCheckedAt: "t" }))).toBeNull();
  });

  it("returns null for an all-zero diff (no information)", () => {
    expect(selectCachedDiffStats(cache({ diffStatCacheCheckedAt: "t", diffStatCacheFilesChanged: 0 }))).toBeNull();
  });

  it("returns stats when there are file changes", () => {
    expect(
      selectCachedDiffStats(cache({ diffStatCacheCheckedAt: "t", diffStatCacheFilesChanged: 2, diffStatCacheInsertions: 10, diffStatCacheDeletions: 4 })),
    ).toEqual({ filesChanged: 2, insertions: 10, deletions: 4 });
  });

  it("treats null insertions/deletions as 0", () => {
    expect(
      selectCachedDiffStats(cache({ diffStatCacheCheckedAt: "t", diffStatCacheFilesChanged: 1 })),
    ).toEqual({ filesChanged: 1, insertions: 0, deletions: 0 });
  });

  it("returns stats when only insertions are present (filesChanged 0 but inserts>0)", () => {
    expect(
      selectCachedDiffStats(cache({ diffStatCacheCheckedAt: "t", diffStatCacheFilesChanged: 0, diffStatCacheInsertions: 5 })),
    ).toEqual({ filesChanged: 0, insertions: 5, deletions: 0 });
  });
});

describe("isPlanOnlySession", () => {
  const base = { status: "idle", planMode: false, ...cache({ diffStatCacheCheckedAt: "t", diffStatCacheFilesChanged: 0 }) };

  it("flags idle, non-plan-mode, zero-change workspaces with a cache check", () => {
    expect(isPlanOnlySession(base)).toBe(true);
  });

  it("does not flag when there are changes", () => {
    expect(isPlanOnlySession({ ...base, diffStatCacheFilesChanged: 2 })).toBe(false);
  });

  it("does not flag non-idle workspaces", () => {
    expect(isPlanOnlySession({ ...base, status: "active" })).toBe(false);
  });

  it("does not flag explicit plan-mode workspaces", () => {
    expect(isPlanOnlySession({ ...base, planMode: true })).toBe(false);
  });

  it("does not flag when no cache check has happened yet", () => {
    expect(isPlanOnlySession({ ...base, diffStatCacheCheckedAt: null })).toBe(false);
  });
});

describe("isDiffCacheStale", () => {
  const TTL = 30_000;
  const now = 1_000_000;

  it("is stale when never checked", () => {
    expect(isDiffCacheStale({ diffStatCacheCheckedAt: null, diffStatCacheHeadSha: null }, null, TTL, now)).toBe(true);
  });

  it("is stale when HEAD advanced past the cached sha", () => {
    const checkedAt = new Date(now).toISOString();
    expect(isDiffCacheStale({ diffStatCacheCheckedAt: checkedAt, diffStatCacheHeadSha: "old" }, "new", TTL, now)).toBe(true);
  });

  it("is fresh when sha matches and within TTL", () => {
    const checkedAt = new Date(now - 1_000).toISOString();
    expect(isDiffCacheStale({ diffStatCacheCheckedAt: checkedAt, diffStatCacheHeadSha: "same" }, "same", TTL, now)).toBe(false);
  });

  it("is stale when older than TTL even with matching sha", () => {
    const checkedAt = new Date(now - TTL - 1).toISOString();
    expect(isDiffCacheStale({ diffStatCacheCheckedAt: checkedAt, diffStatCacheHeadSha: "same" }, "same", TTL, now)).toBe(true);
  });

  it("does not treat a null currentHeadSha as a head change", () => {
    const checkedAt = new Date(now - 1_000).toISOString();
    expect(isDiffCacheStale({ diffStatCacheCheckedAt: checkedAt, diffStatCacheHeadSha: "x" }, null, TTL, now)).toBe(false);
  });
});
