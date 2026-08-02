import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  tryAcquireRepoLock,
  inspectRepoLock,
  withRepoLock,
  REPO_LOCK_STALE_MS,
} from "../src/lib/repo-lock.js";

describe("repo-lock (#993 on-disk cross-process merge lock)", () => {
  const dirs: string[] = [];

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "repo-lock-test-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquires a fresh lock and writes pid/holder/heartbeat to disk", () => {
    const repo = makeRepo();
    const handle = tryAcquireRepoLock(repo, "test-holder");
    expect(handle).not.toBeNull();
    expect(handle!.contents.pid).toBe(process.pid);
    expect(handle!.contents.holder).toBe("test-holder");

    const status = inspectRepoLock(repo);
    expect(status).not.toBeNull();
    expect(status!.contents.holder).toBe("test-holder");
    expect(status!.isStale).toBe(false);
  });

  it("refuses a second acquisition while a live lock is held", () => {
    const repo = makeRepo();
    const first = tryAcquireRepoLock(repo, "holder-a");
    expect(first).not.toBeNull();

    const second = tryAcquireRepoLock(repo, "holder-b");
    expect(second).toBeNull();
  });

  it("release() removes the lockfile and allows re-acquisition", () => {
    const repo = makeRepo();
    const first = tryAcquireRepoLock(repo, "holder-a");
    expect(first).not.toBeNull();
    first!.release();

    expect(inspectRepoLock(repo)).toBeNull();

    const second = tryAcquireRepoLock(repo, "holder-b");
    expect(second).not.toBeNull();
  });

  it("release() never removes a lock it no longer owns (stolen/overwritten lock)", () => {
    const repo = makeRepo();
    const first = tryAcquireRepoLock(repo, "holder-a");
    expect(first).not.toBeNull();

    // Simulate the lock having been force-recovered and re-acquired by someone else
    // between our acquisition and our release call.
    const lockPath = join(repo, ".git", "agentic-kanban-merge.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        hostname: "someone-else",
        holder: "holder-c",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );

    first!.release();

    const stillThere = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(stillThere.holder).toBe("holder-c");
  });

  it("heartbeat() refreshes the heartbeat timestamp for the owning handle", async () => {
    const repo = makeRepo();
    const handle = tryAcquireRepoLock(repo, "holder-a");
    expect(handle).not.toBeNull();

    const before = inspectRepoLock(repo)!.contents.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle!.heartbeat();
    const after = inspectRepoLock(repo)!.contents.heartbeatAt;

    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it("treats a lock with an old heartbeat as stale and recovers it", () => {
    const repo = makeRepo();
    const lockPath = join(repo, ".git", "agentic-kanban-merge.lock");
    const staleTime = new Date(Date.now() - REPO_LOCK_STALE_MS - 5_000).toISOString();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 12345,
        hostname: "crashed-host",
        holder: "crashed-holder",
        acquiredAt: staleTime,
        heartbeatAt: staleTime,
      }),
    );

    const status = inspectRepoLock(repo);
    expect(status!.isStale).toBe(true);

    const recovered = tryAcquireRepoLock(repo, "new-holder");
    expect(recovered).not.toBeNull();
    expect(recovered!.contents.holder).toBe("new-holder");
  });

  it("refuses to acquire (and does not fabricate .git) for a repoPath with no .git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-lock-test-nogit-"));
    dirs.push(dir);

    const handle = tryAcquireRepoLock(dir, "test-holder");

    expect(handle).toBeNull();
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("refuses recovery of a fresh (non-stale) lock even from a different holder string", () => {
    const repo = makeRepo();
    tryAcquireRepoLock(repo, "holder-a");
    const attempt = tryAcquireRepoLock(repo, "holder-b");
    expect(attempt).toBeNull();
  });

  describe("#207: same-host dead-process reclaim", () => {
    // A pid that is (overwhelmingly likely to be) not running on this machine —
    // same convention the existing "release() never removes a lock it no longer
    // owns" test above uses for a fabricated foreign lock.
    const DEAD_PID = 999999;

    it("reclaims immediately a fresh-heartbeat lock held by a dead pid on this host (frozen heartbeat, not yet stale)", () => {
      const repo = makeRepo();
      const lockPath = join(repo, ".git", "agentic-kanban-merge.lock");
      // Heartbeat is FRESH (just now) — simulates a process that died the instant
      // after its last heartbeat write, well inside REPO_LOCK_STALE_MS.
      const now = new Date().toISOString();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID,
          hostname: hostname(),
          holder: "workspace:dead-holder",
          acquiredAt: now,
          heartbeatAt: now,
        }),
      );

      const status = inspectRepoLock(repo);
      expect(status!.isStale).toBe(false);
      expect(status!.ownerProcessDead).toBe(true);

      const recovered = tryAcquireRepoLock(repo, "new-holder");
      expect(recovered).not.toBeNull();
      expect(recovered!.contents.holder).toBe("new-holder");
    });

    it("does NOT reclaim a fresh lock whose pid is alive on this host (our own pid)", () => {
      const repo = makeRepo();
      const lockPath = join(repo, ".git", "agentic-kanban-merge.lock");
      const now = new Date().toISOString();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid, // definitely alive — it's us
          hostname: hostname(),
          holder: "workspace:live-holder",
          acquiredAt: now,
          heartbeatAt: now,
        }),
      );

      expect(inspectRepoLock(repo)!.ownerProcessDead).toBe(false);
      expect(tryAcquireRepoLock(repo, "new-holder")).toBeNull();
    });

    it("does NOT probe liveness for a lock recorded under a different hostname (falls back to staleness only)", () => {
      const repo = makeRepo();
      const lockPath = join(repo, ".git", "agentic-kanban-merge.lock");
      const now = new Date().toISOString();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID, // would be "dead" on THIS host, but the lock is foreign
          hostname: "some-other-host",
          holder: "workspace:remote-holder",
          acquiredAt: now,
          heartbeatAt: now,
        }),
      );

      const status = inspectRepoLock(repo);
      expect(status!.ownerProcessDead).toBe(false);
      expect(tryAcquireRepoLock(repo, "new-holder")).toBeNull();
    });
  });

  it("withRepoLock runs work under the lock and releases it afterward, success or failure", async () => {
    const repo = makeRepo();

    const result = await withRepoLock(repo, "worker", async () => {
      expect(inspectRepoLock(repo)).not.toBeNull();
      return 42;
    });
    expect(result).toBe(42);
    expect(inspectRepoLock(repo)).toBeNull();

    await expect(
      withRepoLock(repo, "worker", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(inspectRepoLock(repo)).toBeNull();
  });

  it("withRepoLock serializes two concurrent callers on the same repo", async () => {
    const repo = makeRepo();
    const order: string[] = [];

    const a = withRepoLock(repo, "a", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-end");
    }, { pollMs: 10 });

    // Give `a` a head start so it acquires first.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const b = withRepoLock(repo, "b", async () => {
      order.push("b-start");
      order.push("b-end");
    }, { pollMs: 10 });

    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("withRepoLock times out if the lock is never released", async () => {
    const repo = makeRepo();
    const handle = tryAcquireRepoLock(repo, "stuck-holder");
    expect(handle).not.toBeNull();

    await expect(
      withRepoLock(repo, "waiter", async () => "should not run", { pollMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});
