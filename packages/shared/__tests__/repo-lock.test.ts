import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  tryAcquireRepoLock,
  attemptRepoLock,
  inspectRepoLock,
  waitForRepoLock,
  withRepoLock,
  RepoLockUnavailableError,
  REPO_LOCK_STALE_MS,
  REPO_LOCK_LIVE_HOLDER_MAX_MS,
} from "../src/lib/repo-lock.js";

describe("repo-lock (#993 on-disk cross-process merge lock)", () => {
  const dirs: string[] = [];

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-repo-lock-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "ak-repo-lock-test-nogit-"));
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

  describe("a live same-host holder is never reclaimed on heartbeat staleness alone", () => {
    const lockFor = (repo: string) => join(repo, ".git", "agentic-kanban-merge.lock");

    function writeLock(repo: string, contents: Record<string, unknown>): void {
      writeFileSync(lockFor(repo), JSON.stringify(contents));
    }

    it("refuses reclaim when the heartbeat is STALE but the same-host pid is provably alive", () => {
      // The real scenario: the holder is mid-`git`, but its heartbeat write lagged past the
      // 60s window (blocked event loop, system sleep/resume, an AV-locked write on Windows).
      // `isProcessConfirmedDead` only ever SHORTENED the wait, so nothing blocked the steal.
      const repo = makeRepo();
      const stale = new Date(Date.now() - REPO_LOCK_STALE_MS - 30_000).toISOString();
      writeLock(repo, {
        pid: process.pid, // definitely alive — it's us
        hostname: hostname(),
        holder: "workspace:live-but-lagging",
        acquiredAt: stale,
        heartbeatAt: stale,
      });

      const status = inspectRepoLock(repo);
      expect(status!.isStale).toBe(true);
      expect(status!.ownerProcessAlive).toBe(true);
      expect(status!.ownerProcessDead).toBe(false);

      expect(tryAcquireRepoLock(repo, "thief")).toBeNull();
      // And the holder's lockfile is untouched — not merely un-acquired.
      expect(JSON.parse(readFileSync(lockFor(repo), "utf8")).holder).toBe("workspace:live-but-lagging");
    });

    it("still reclaims a stale CROSS-HOST lock (liveness is unprovable there — unchanged behaviour)", () => {
      const repo = makeRepo();
      const stale = new Date(Date.now() - REPO_LOCK_STALE_MS - 30_000).toISOString();
      writeLock(repo, {
        pid: process.pid,
        hostname: "some-other-host",
        holder: "workspace:remote",
        acquiredAt: stale,
        heartbeatAt: stale,
      });

      expect(inspectRepoLock(repo)!.ownerProcessAlive).toBe(false);
      expect(tryAcquireRepoLock(repo, "new-holder")).not.toBeNull();
    });

    it("still reclaims a same-host CONFIRMED-DEAD pid immediately (#207 unchanged)", () => {
      const repo = makeRepo();
      const now = new Date().toISOString();
      writeLock(repo, {
        pid: 999999,
        hostname: hostname(),
        holder: "workspace:dead",
        acquiredAt: now,
        heartbeatAt: now,
      });

      expect(inspectRepoLock(repo)!.ownerProcessAlive).toBe(false);
      expect(tryAcquireRepoLock(repo, "new-holder")).not.toBeNull();
    });

    it("reclaims even a live holder past REPO_LOCK_LIVE_HOLDER_MAX_MS (a recycled pid must never wedge the repo)", () => {
      const repo = makeRepo();
      const ancient = new Date(Date.now() - REPO_LOCK_LIVE_HOLDER_MAX_MS - 60_000).toISOString();
      writeLock(repo, {
        pid: process.pid,
        hostname: hostname(),
        holder: "workspace:pid-recycled-after-reboot",
        acquiredAt: ancient,
        heartbeatAt: ancient,
      });

      expect(inspectRepoLock(repo)!.ownerProcessAlive).toBe(true);
      const recovered = tryAcquireRepoLock(repo, "new-holder");
      expect(recovered).not.toBeNull();
      expect(recovered!.contents.holder).toBe("new-holder");
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

/**
 * #230 — CONTENDED vs UNAVAILABLE, and a bound that can actually fail a test.
 *
 * Both halves used to be untestable:
 *  - `tryAcquireRepoLock` collapsed "someone holds it" and "this path cannot be locked"
 *    into one `null`, and a bare `catch { return null }` around the lockfile write
 *    reported EPERM/EACCES as contention. A caller polling on that hangs forever.
 *  - the wait bound lived in a module-private const read against `Date.now()`, so no test
 *    could fail if the deadline check were deleted — observing it needed 90 real minutes.
 *    `waitForRepoLock` therefore takes an injected clock and sleeper.
 */
describe("repo-lock CONTENDED vs UNAVAILABLE (#230)", () => {
  const dirs: string[] = [];

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-repo-lock-230-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("classifies a live holder as CONTENDED (waiting is correct)", () => {
    const repo = makeRepo();
    expect(attemptRepoLock(repo, "holder-a").outcome).toBe("acquired");

    const second = attemptRepoLock(repo, "holder-b");
    expect(second.outcome).toBe("contended");
    if (second.outcome === "contended") expect(second.heldBy?.holder).toBe("holder-a");
  });

  it("classifies a repoPath with no .git as UNAVAILABLE, not as contention", () => {
    // The measured #230 trigger: a synthetic repoPath (`/repo-<uuid>`), as several merge
    // tests use. Pre-fix this returned the same `null` as a busy lock, and the caller
    // polled it until vitest's 60s timeout with zero diagnostic output.
    const missing = join(tmpdir(), `repo-lock-230-missing-${Date.now()}`);
    const attempt = attemptRepoLock(missing, "holder");
    expect(attempt.outcome).toBe("unavailable");
    if (attempt.outcome === "unavailable") {
      expect(attempt.code).toBe("ENOENT");
      expect(attempt.reason).toMatch(/does not exist/);
    }
  });

  it("classifies an unwritable lock path (IO error, not EEXIST) as UNAVAILABLE", () => {
    // A REAL instance of the class the old bare `catch { return null }` mislabelled as
    // contention: `.git` is a FILE, not a directory — exactly what a git WORKTREE has, so
    // this is what happens when a worktree path reaches a repoPath parameter. `existsSync`
    // sees `.git`, but the lockfile under it can never be created (ENOTDIR/ENOENT). Pre-fix
    // the caller polled that forever; the errno is not EEXIST, so it must read UNAVAILABLE.
    const dir = mkdtempSync(join(tmpdir(), "ak-repo-lock-230-gitfile-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");

    const attempt = attemptRepoLock(dir, "holder");
    expect(attempt.outcome).toBe("unavailable");
    if (attempt.outcome === "unavailable") expect(attempt.code).not.toBe("EEXIST");
  });

  it("still classifies a LOST RACE (EEXIST on the write) as contention", () => {
    // An unparseable lockfile makes `inspectRepoLock` return null, so the attempt falls
    // through to the `wx` write and hits the real EEXIST — the genuine lost-race errno,
    // which must stay CONTENDED (waiting is correct; the winner will release).
    const repo = makeRepo();
    writeFileSync(join(repo, ".git", "agentic-kanban-merge.lock"), "not json");

    expect(attemptRepoLock(repo, "holder").outcome).toBe("contended");
  });

  it("waitForRepoLock FAILS FAST on an unavailable path instead of polling it", async () => {
    const missing = join(tmpdir(), `repo-lock-230-nowait-${Date.now()}`);
    let sleeps = 0;
    await expect(
      waitForRepoLock(missing, "holder", {
        timeoutMs: 60 * 60 * 1000,
        sleep: async () => { sleeps++; },
      }),
    ).rejects.toBeInstanceOf(RepoLockUnavailableError);
    // The point of the fix: not one poll was spent on a path that can never be locked.
    expect(sleeps).toBe(0);
  });

  /**
   * THE BOUND ITSELF — the assertion that fails if the deadline check in `waitForRepoLock`
   * is removed or raised. A virtual clock does the waiting, so the whole 10-simulated-second
   * budget costs microseconds; the `attempt` tripwire converts an unbounded loop into a
   * distinct, FAST failure instead of a hang, so the red is legible rather than a timeout.
   * MEASURED red-then-green: see the commit message.
   */
  it("waitForRepoLock stops waiting at the bound on a permanently CONTENDED lock", async () => {
    let virtualNow = 0;
    let attempts = 0;
    const budgetMs = 10_000;
    const pollMs = 500;
    const maxAttempts = budgetMs / pollMs + 1; // one attempt per poll + the one at the deadline
    await expect(
      waitForRepoLock("/irrelevant", "waiter", {
        timeoutMs: budgetMs,
        pollMs,
        now: () => virtualNow,
        sleep: async (ms) => { virtualNow += ms; },
        attempt: () => {
          attempts++;
          if (attempts > maxAttempts) {
            // Tripwire: only reachable when nothing stops the loop at the deadline.
            throw new Error(`waitForRepoLock is UNBOUNDED: ${attempts} attempts, virtual clock at ${virtualNow}ms`);
          }
          return { outcome: "contended", reason: "held by someone-else pid=1" };
        },
      }),
    ).rejects.toThrow(/timed out after 10s/);
    expect(attempts).toBe(maxAttempts);
    expect(virtualNow).toBe(budgetMs);
  }, 5_000);

  it("waitForRepoLock reports progress while waiting, so a stuck wait is diagnosable", async () => {
    let virtualNow = 0;
    const waits: number[] = [];
    await expect(
      waitForRepoLock("/irrelevant", "waiter", {
        timeoutMs: 2_000,
        pollMs: 500,
        now: () => virtualNow,
        sleep: async (ms) => { virtualNow += ms; },
        attempt: () => ({ outcome: "contended", reason: "held by someone-else pid=1" }),
        onContended: (_a, waitedMs) => waits.push(waitedMs),
      }),
    ).rejects.toThrow(/timed out/);
    expect(waits).toEqual([0, 500, 1000, 1500, 2000]);
  }, 5_000);
});
