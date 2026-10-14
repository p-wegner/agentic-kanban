import { describe, it, expect } from "vitest";
import { withCacheLock, retryOnRefLockRace, isRefLockRace } from "../worker/worker-repo-lock.js";

describe("#1474 per-cached-clone serialization", () => {
  it("runs two operations on the same clone one after the other, and both succeed", async () => {
    let active = 0;
    let maxActive = 0;
    const op = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "ok";
    };
    const results = await Promise.all([withCacheLock("/w/repos/p1", op), withCacheLock("/w/repos/p1", op)]);
    expect(results).toEqual(["ok", "ok"]);
    expect(maxActive).toBe(1);
  });

  it("does not make different clones wait on each other", async () => {
    let active = 0;
    let maxActive = 0;
    const op = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all([withCacheLock("/w/repos/a", op), withCacheLock("/w/repos/b", op)]);
    expect(maxActive).toBe(2);
  });

  it("a failing holder does not poison the queue", async () => {
    const failing = withCacheLock("/w/repos/p2", async () => { throw new Error("boom"); });
    const next = withCacheLock("/w/repos/p2", async () => "after");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
  });
});

describe("#1474 ref-lock retry", () => {
  it("recognizes the git race messages", () => {
    expect(isRefLockRace("cannot lock ref 'refs/remotes/origin/master': is at a but expected b")).toBe(true);
    expect(isRefLockRace("error: unable to update local ref")).toBe(true);
    expect(isRefLockRace("fatal: repository not found")).toBe(false);
  });

  it("retries once on a lock race", async () => {
    let calls = 0;
    const out = await retryOnRefLockRace(async () => {
      if (++calls === 1) throw new Error("cannot lock ref 'refs/remotes/origin/master'");
      return "done";
    }, () => {});
    expect(out).toBe("done");
    expect(calls).toBe(2);
  });

  it("does not retry other errors, and retries only once", async () => {
    let calls = 0;
    await expect(retryOnRefLockRace(async () => { calls++; throw new Error("auth failed"); }, () => {})).rejects.toThrow("auth failed");
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryOnRefLockRace(async () => { calls++; throw new Error("cannot lock ref x"); }, () => {})).rejects.toThrow("cannot lock ref");
    expect(calls).toBe(2);
  });
});
