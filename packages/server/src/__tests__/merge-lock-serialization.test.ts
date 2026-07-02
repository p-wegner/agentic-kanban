import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireRepoMergeLock,
  activeMerges,
  MERGE_LOCK_STALE_MS,
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
