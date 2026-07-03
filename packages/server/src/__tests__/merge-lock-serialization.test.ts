import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRepoMergeLock,
  activeMerges,
  tryRecoverStaleMergeLock,
  MERGE_LOCK_STALE_MS,
  GIT_INDEX_LOCK_FRESH_MS,
  type ActiveMergeLock,
} from "../services/workspace-internals.js";

// #944: the activeMerges lock had two incompatible protocols — the autoMerge
// path awaited a pending lock once and then proceeded WITHOUT re-checking the
// map, so two callers queued behind the same merge both proceeded and ran
// concurrent git merges (the second silently overwriting the first's lock
// entry). These tests pin the single correct protocol: acquireRepoMergeLock
// serializes all acquisitions per repoPath, strictly one-after-the-other.

const REPO = "/tmp/serialization-test-repo";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("acquireRepoMergeLock serialization (#944)", () => {
  beforeEach(() => {
    activeMerges.clear();
  });

  it("runs two concurrent acquisitions strictly one-after-the-other", async () => {
    const events: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const a = acquireRepoMergeLock(REPO, "ws-a", async () => {
      events.push("a-start");
      await gateA.promise;
      events.push("a-end");
    });
    const b = acquireRepoMergeLock(REPO, "ws-b", async () => {
      events.push("b-start");
      await gateB.promise;
      events.push("b-end");
    });

    // Let b reach its wait on a's lock; a's work must have started, b's not.
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["a-start"]);

    gateA.resolve();
    await a;
    gateB.resolve();
    await b;

    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("serializes three waiters queued behind the same lock (the old wait-then-proceed race)", async () => {
    const events: string[] = [];
    let running = 0;
    let maxConcurrent = 0;

    const work = (name: string) => async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      events.push(`${name}-start`);
      // Yield a few times so overlapping executions would interleave.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      events.push(`${name}-end`);
      running -= 1;
    };

    // All three launched in the same tick: b and c both queue behind a. Under
    // the old protocol, b and c would BOTH proceed once a finished.
    await Promise.all([
      acquireRepoMergeLock(REPO, "ws-a", work("a")),
      acquireRepoMergeLock(REPO, "ws-b", work("b")),
      acquireRepoMergeLock(REPO, "ws-c", work("c")),
    ]);

    expect(maxConcurrent).toBe(1);
    // Every start is immediately followed by its own end — no interleaving.
    for (let i = 0; i < events.length; i += 2) {
      const name = events[i].replace("-start", "");
      expect(events[i]).toBe(`${name}-start`);
      expect(events[i + 1]).toBe(`${name}-end`);
    }
    expect(events).toHaveLength(6);
  });

  it("never lets a second caller overwrite the first caller's lock entry", async () => {
    const gateA = deferred();
    const observed: string[] = [];

    const a = acquireRepoMergeLock(REPO, "ws-a", async () => {
      await gateA.promise;
    });
    const b = acquireRepoMergeLock(REPO, "ws-b", async () => {
      /* no-op */
    });

    // While a's work is in flight, the map entry must still belong to ws-a
    // (old autoMerge code overwrote it with the second caller's lock).
    await new Promise((r) => setImmediate(r));
    observed.push(activeMerges.get(REPO)!.workspaceId);
    await new Promise((r) => setImmediate(r));
    observed.push(activeMerges.get(REPO)!.workspaceId);

    gateA.resolve();
    await Promise.all([a, b]);

    expect(observed).toEqual(["ws-a", "ws-a"]);
    // Fully released afterwards.
    expect(activeMerges.has(REPO)).toBe(false);
  });

  it("releases the lock on rejection and lets the next acquirer proceed", async () => {
    const events: string[] = [];

    const a = acquireRepoMergeLock(REPO, "ws-a", async () => {
      events.push("a-start");
      throw new Error("merge failed");
    });
    const b = acquireRepoMergeLock(REPO, "ws-b", async () => {
      events.push("b-start");
    });

    await expect(a).rejects.toThrow("merge failed");
    await b;

    expect(events).toEqual(["a-start", "b-start"]);
    expect(activeMerges.has(REPO)).toBe(false);
  });

  it("recovers a stale lock instead of waiting on it forever", async () => {
    // A hot-reload can strand a lock whose promise never settles.
    activeMerges.set(REPO, {
      promise: new Promise(() => {}),
      workspaceId: "ws-stale",
      repoPath: REPO,
      startedAt: new Date(Date.now() - MERGE_LOCK_STALE_MS - 1000).toISOString(),
      startedAtMs: Date.now() - MERGE_LOCK_STALE_MS - 1000,
    });

    const result = await acquireRepoMergeLock(REPO, "ws-fresh", async () => "done");
    expect(result).toBe("done");
    expect(activeMerges.has(REPO)).toBe(false);
  });

  // #970 hole 1: doMerge used to schedule the post-merge main-checkout cleanup
  // (the deferred `git reset --hard`) via setImmediate AFTER returning — i.e.
  // after the lock was released — so a second merge could acquire the lock and
  // observe the main checkout mid-cleanup (stale tree → dirty-main block).
  // These tests pin the fix: extendHold keeps the lock held until the cleanup
  // extension settles, while the caller still gets the result early.
  describe("extendHold — lock held through deferred post-merge cleanup (#970)", () => {
    it("does not release the lock (nor start the next merge) until the hold extension settles", async () => {
      const events: string[] = [];
      const cleanupGate = deferred();

      const a = acquireRepoMergeLock(REPO, "ws-a", async (extendHold) => {
        events.push("a-merge");
        // Mirrors doMerge: register the deferred cleanup synchronously, then
        // return the response immediately.
        extendHold(new Promise<void>((resolve) => {
          setImmediate(() => {
            void cleanupGate.promise.then(() => {
              events.push("a-cleanup-done");
              resolve();
            });
          });
        }));
        return "a-response";
      });

      const b = acquireRepoMergeLock(REPO, "ws-b", async () => {
        events.push("b-merge");
        return "b-response";
      });

      // a's RESULT resolves early (the HTTP caller isn't held up by cleanup)...
      await expect(a).resolves.toBe("a-response");
      // ...but the lock is still held: b must not have started, and the map
      // entry must still belong to ws-a.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(events).toEqual(["a-merge"]);
      expect(activeMerges.get(REPO)?.workspaceId).toBe("ws-a");

      cleanupGate.resolve();
      await expect(b).resolves.toBe("b-response");
      expect(events).toEqual(["a-merge", "a-cleanup-done", "b-merge"]);
      expect(activeMerges.has(REPO)).toBe(false);
    });

    it("releases the lock after the extension even when the merge itself rejects", async () => {
      const events: string[] = [];
      const a = acquireRepoMergeLock(REPO, "ws-a", async (extendHold) => {
        extendHold(Promise.resolve().then(() => { events.push("a-cleanup"); }));
        throw new Error("merge failed");
      });
      const b = acquireRepoMergeLock(REPO, "ws-b", async () => {
        events.push("b-merge");
      });

      await expect(a).rejects.toThrow("merge failed");
      await b;
      expect(events).toEqual(["a-cleanup", "b-merge"]);
      expect(activeMerges.has(REPO)).toBe(false);
    });

    it("a rejected hold extension still releases the lock", async () => {
      const a = acquireRepoMergeLock(REPO, "ws-a", async (extendHold) => {
        extendHold(Promise.reject(new Error("cleanup blew up")));
        return "ok";
      });
      await expect(a).resolves.toBe("ok");
      const b = await acquireRepoMergeLock(REPO, "ws-b", async () => "next");
      expect(b).toBe("next");
      expect(activeMerges.has(REPO)).toBe(false);
    });

    it("exposes resultPromise on the lock entry for the manual-merge reuse path", async () => {
      const cleanupGate = deferred();
      const a = acquireRepoMergeLock(REPO, "ws-a", async (extendHold) => {
        extendHold(cleanupGate.promise);
        return "the-response";
      });
      await a;
      // Lock still held by the pending cleanup; reuse must see the result.
      const lock = activeMerges.get(REPO);
      expect(lock?.workspaceId).toBe("ws-a");
      await expect(lock!.resultPromise).resolves.toBe("the-response");
      cleanupGate.resolve();
      await lock!.promise;
      expect(activeMerges.has(REPO)).toBe(false);
    });
  });

  // #970 hole 2: stale-lock recovery deleted the map entry without checking
  // whether the holder's git process was gone. A fresh .git/index.lock in the
  // target repo now refuses recovery.
  describe("stale-lock recovery checks .git/index.lock (#970)", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "merge-lock-stale-"));
      mkdirSync(join(repoDir, ".git"), { recursive: true });
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    function staleLock(): ActiveMergeLock {
      const lock: ActiveMergeLock = {
        promise: new Promise(() => {}),
        workspaceId: "ws-stale",
        repoPath: repoDir,
        startedAt: new Date(Date.now() - MERGE_LOCK_STALE_MS - 1000).toISOString(),
        startedAtMs: Date.now() - MERGE_LOCK_STALE_MS - 1000,
      };
      activeMerges.set(repoDir, lock);
      return lock;
    }

    it("refuses recovery when a fresh .git/index.lock is present", () => {
      const lock = staleLock();
      writeFileSync(join(repoDir, ".git", "index.lock"), "");
      expect(tryRecoverStaleMergeLock(repoDir, lock)).toBe(false);
      expect(activeMerges.get(repoDir)).toBe(lock);
    });

    it("recovers when the .git/index.lock is old debris", () => {
      const lock = staleLock();
      const indexLockPath = join(repoDir, ".git", "index.lock");
      writeFileSync(indexLockPath, "");
      const oldSec = (Date.now() - GIT_INDEX_LOCK_FRESH_MS - 60_000) / 1000;
      utimesSync(indexLockPath, oldSec, oldSec);
      expect(tryRecoverStaleMergeLock(repoDir, lock)).toBe(true);
      expect(activeMerges.has(repoDir)).toBe(false);
    });

    it("recovers when no index.lock exists", () => {
      const lock = staleLock();
      expect(tryRecoverStaleMergeLock(repoDir, lock)).toBe(true);
      expect(activeMerges.has(repoDir)).toBe(false);
    });
  });

  it("does not serialize acquisitions across different repoPaths", async () => {
    const gate = deferred();
    const events: string[] = [];

    const a = acquireRepoMergeLock("/tmp/repo-one", "ws-a", async () => {
      events.push("one-start");
      await gate.promise;
    });
    const b = acquireRepoMergeLock("/tmp/repo-two", "ws-b", async () => {
      events.push("two-start");
    });

    await b;
    expect(events).toContain("two-start");
    gate.resolve();
    await a;
  });
});
