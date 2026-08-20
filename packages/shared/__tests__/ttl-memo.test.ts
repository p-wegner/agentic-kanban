import { describe, expect, it, vi } from "vitest";
import { createTtlMemo } from "../src/lib/ttl-memo.js";

describe("createTtlMemo (#559)", () => {
  it("returns a value inside the TTL and forgets it after", () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    memo.set("a", 1, { nowMs: 0 });
    expect(memo.get("a", { nowMs: 999 })).toBe(1);
    expect(memo.get("a", { nowMs: 1000 })).toBeUndefined();
  });

  it("EVICTS on an expired read rather than leaving the entry", () => {
    // Keyed by workspace/project ids that come and go, so an expired entry nobody reads
    // again is a leak.
    const memo = createTtlMemo<string, number>({ ttlMs: 10 });
    memo.set("a", 1, { nowMs: 0 });
    expect(memo.size).toBe(1);
    memo.get("a", { nowMs: 50 });
    expect(memo.size).toBe(0);
  });

  it("crossing the TTL needs no sleeping — the whole point of injecting nowMs", () => {
    const memo = createTtlMemo<string, string>({ ttlMs: 2000 });
    memo.set("k", "v", { nowMs: 1_000_000 });
    expect(memo.get("k", { nowMs: 1_001_999 })).toBe("v");
    expect(memo.get("k", { nowMs: 1_002_000 })).toBeUndefined();
  });

  it("single-flight: concurrent callers for one key share ONE call", async () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    const fn = vi.fn(async () => 42);
    const results = await Promise.all([
      memo.singleFlight("k", fn, { nowMs: 0 }),
      memo.singleFlight("k", fn, { nowMs: 0 }),
      memo.singleFlight("k", fn, { nowMs: 0 }),
    ]);
    expect(results).toEqual([42, 42, 42]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("single-flight serves a later caller from the memo, not a second call", async () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    const fn = vi.fn(async () => 7);
    expect(await memo.singleFlight("k", fn, { nowMs: 0 })).toBe(7);
    expect(await memo.singleFlight("k", fn, { nowMs: 500 })).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("single-flight re-runs after the TTL", async () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 100 });
    let n = 0;
    const fn = async () => ++n;
    expect(await memo.singleFlight("k", fn, { nowMs: 0 })).toBe(1);
    expect(await memo.singleFlight("k", fn, { nowMs: 200 })).toBe(2);
  });

  it("a rejected single-flight is not cached and does not wedge the key", async () => {
    // The `finally` matters: without it the failed promise stays in `inFlight` and every
    // later caller awaits a promise that already rejected.
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    await expect(
      memo.singleFlight("k", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    expect(await memo.singleFlight("k", async () => 5)).toBe(5);
  });

  it("invalidate drops one key, or a whole string prefix", () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    memo.set("p:1", 1, { nowMs: 0 });
    memo.set("p:2", 2, { nowMs: 0 });
    memo.set("q:1", 3, { nowMs: 0 });
    memo.invalidate("p:1");
    expect(memo.get("p:1", { nowMs: 1 })).toBeUndefined();
    expect(memo.get("p:2", { nowMs: 1 })).toBe(2);
    memo.invalidate("p:");
    expect(memo.get("p:2", { nowMs: 1 })).toBeUndefined();
    expect(memo.get("q:1", { nowMs: 1 })).toBe(3);
  });

  it("clear() replaces the bespoke __resetXForTests exports", () => {
    const memo = createTtlMemo<string, number>({ ttlMs: 1000 });
    memo.set("a", 1, { nowMs: 0 });
    memo.clear();
    expect(memo.size).toBe(0);
  });
});
