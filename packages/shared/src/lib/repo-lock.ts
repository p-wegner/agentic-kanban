import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * On-disk, cross-process repo lock (#993).
 *
 * `workspace-internals.ts`'s `activeMerges` map is in-process memory: it only
 * serializes callers that happen to share this server's event loop. It has no
 * visibility into a Conductor-loop agent running `git` in the same repoPath, a
 * human running git by hand, or a second server process (e.g. surviving a
 * hot-reload restart that drops the old process's map but not its in-flight
 * git command). This module is the cross-process source of truth those other
 * writers must also acquire: a single lockfile per repo, under `.git/` (so it
 * lives with the repo, not the worktree, and is naturally excluded from
 * tracked content), holding the holder's pid + hostname + heartbeat timestamp.
 *
 * Acquisition is atomic via `wx` (fail if the file already exists) — the same
 * primitive git itself uses for `.git/index.lock`. Staleness is judged by
 * heartbeat age by default: pids can be reused across a reboot, and a
 * foreign host's pid can never be probed at all, so a heartbeat that stops
 * updating is the only host-agnostic signal that a holder is gone.
 *
 * For a SAME-HOST holder we don't have to wait that out (#207): if the
 * recorded hostname matches ours, `process.kill(pid, 0)` cheaply tells us
 * whether that pid is still alive. A confirmed-dead same-host holder (e.g.
 * the server process was OOM-killed or crashed mid-merge) is reclaimed
 * immediately regardless of heartbeat age — otherwise every merge on that
 * repo is blocked for up to {@link REPO_LOCK_STALE_MS} by a holder that no
 * longer exists. A live pid (or a cross-host / unreadable holder) is never
 * treated as dead by this check — it only ever shortens the wait, never
 * widens it — so the heartbeat-staleness path stays the fallback.
 */

const LOCK_FILE_NAME = "agentic-kanban-merge.lock";

/** A heartbeat older than this means the holder is presumed dead (crashed, hot-reloaded, killed). */
export const REPO_LOCK_STALE_MS = 60 * 1000;

/** How often a held lock's heartbeat is refreshed while work is in flight. */
export const REPO_LOCK_HEARTBEAT_INTERVAL_MS = 15 * 1000;

export interface RepoLockContents {
  pid: number;
  hostname: string;
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface RepoLockHandle {
  path: string;
  contents: RepoLockContents;
  /** Refresh the on-disk heartbeat timestamp. No-op if the lock was released or stolen. */
  heartbeat: () => void;
  /** Remove the lockfile, but only if it still belongs to this handle (never releases someone else's lock). */
  release: () => void;
}

function lockPathFor(repoPath: string): string {
  return join(repoPath, ".git", LOCK_FILE_NAME);
}

function readLockContents(lockPath: string): RepoLockContents | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RepoLockContents>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.holder === "string" &&
      typeof parsed.acquiredAt === "string" &&
      typeof parsed.heartbeatAt === "string"
    ) {
      return parsed as RepoLockContents;
    }
    return null;
  } catch {
    return null;
  }
}

function heartbeatAgeMs(contents: RepoLockContents, nowMs: number): number {
  const heartbeatMs = Date.parse(contents.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - heartbeatMs);
}

/**
 * True only when we can be CONFIDENT the holder is gone: same host, and the
 * pid no longer exists (ESRCH). Any other outcome — a live pid, a pid owned
 * by another user (EPERM, still alive), or an unexpected error — defaults to
 * "alive", since wrongly reclaiming a live lock is far worse than waiting out
 * the heartbeat window.
 */
function isProcessConfirmedDead(contents: RepoLockContents): boolean {
  if (contents.hostname !== hostname()) return false;
  try {
    process.kill(contents.pid, 0);
    return false;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    return code === "ESRCH";
  }
}

export interface RepoLockStatus {
  path: string;
  contents: RepoLockContents;
  ageMs: number;
  isStale: boolean;
  /** Same-host holder whose pid no longer exists — reclaimable even if not yet stale. See {@link isProcessConfirmedDead}. */
  ownerProcessDead: boolean;
}

/** Inspect the current lock (if any) without acquiring or mutating it. */
export function inspectRepoLock(repoPath: string, nowMs = Date.now()): RepoLockStatus | null {
  const lockPath = lockPathFor(repoPath);
  if (!existsSync(lockPath)) return null;
  const contents = readLockContents(lockPath);
  if (!contents) return null;
  const ageMs = heartbeatAgeMs(contents, nowMs);
  return {
    path: lockPath,
    contents,
    ageMs,
    isStale: ageMs > REPO_LOCK_STALE_MS,
    ownerProcessDead: isProcessConfirmedDead(contents),
  };
}

/**
 * Force-remove a lock only if it is still the exact stale entry we inspected
 * (contents match) — prevents a TOCTOU race where the holder heartbeats or a
 * new holder acquires between inspection and recovery.
 */
function recoverIfUnchanged(lockPath: string, expected: RepoLockContents): boolean {
  const current = readLockContents(lockPath);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
  try {
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire the on-disk repo lock exactly once (no waiting/retry —
 * callers that want to wait for an in-flight holder should poll via
 * {@link inspectRepoLock} or layer their own retry/backoff on top).
 *
 * Returns a handle on success, or `null` if a live (non-stale, live-process)
 * lock is held by someone else. A stale lock (heartbeat older than
 * {@link REPO_LOCK_STALE_MS}) is recovered automatically before the
 * acquisition attempt — as is a same-host lock whose holder pid is confirmed
 * dead ({@link isProcessConfirmedDead}), even if its heartbeat isn't stale
 * yet (#207: a killed holder's heartbeat freezes rather than advancing, so
 * without this check every merge on the repo would block for the full
 * staleness window behind a holder that no longer exists).
 */
export function tryAcquireRepoLock(repoPath: string, holder: string, nowMs = Date.now()): RepoLockHandle | null {
  const lockPath = lockPathFor(repoPath);
  const existing = inspectRepoLock(repoPath, nowMs);
  if (existing) {
    if (!existing.isStale && !existing.ownerProcessDead) return null;
    if (existing.ownerProcessDead && !existing.isStale) {
      console.warn(
        `[repo-lock] recovering lock at ${lockPath} held by DEAD process pid=${existing.contents.pid} on this host ` +
          `(heartbeat age=${Math.round(existing.ageMs / 1000)}s, still within the ${Math.round(REPO_LOCK_STALE_MS / 1000)}s staleness window) ` +
          `(holder=${existing.contents.holder})`,
      );
    } else {
      console.warn(
        `[repo-lock] recovering stale lock at ${lockPath}: holder pid=${existing.contents.pid} host=${existing.contents.hostname} ` +
          `heartbeat age=${Math.round(existing.ageMs / 1000)}s (holder=${existing.contents.holder})`,
      );
    }
    if (!recoverIfUnchanged(lockPath, existing.contents)) {
      // Someone else recovered/reacquired first — refuse rather than clobber them.
      return null;
    }
  }

  const contents: RepoLockContents = {
    pid: process.pid,
    hostname: hostname(),
    holder,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
  };

  if (!existsSync(join(repoPath, ".git"))) {
    console.warn(`[repo-lock] refusing to acquire: ${join(repoPath, ".git")} does not exist (repoPath misconfigured?)`);
    return null;
  }

  try {
    writeFileSync(lockPath, JSON.stringify(contents), { flag: "wx" });
  } catch {
    // Lost the race to another acquirer between our staleness check and the write.
    return null;
  }

  const handle: RepoLockHandle = {
    path: lockPath,
    contents,
    heartbeat: () => {
      const current = readLockContents(lockPath);
      if (!current || current.pid !== contents.pid || current.acquiredAt !== contents.acquiredAt) return;
      contents.heartbeatAt = new Date().toISOString();
      try {
        writeFileSync(lockPath, JSON.stringify(contents));
      } catch {
        // Best-effort — a failed heartbeat write just makes recovery-by-staleness kick in sooner.
      }
    },
    release: () => {
      const current = readLockContents(lockPath);
      if (!current || current.pid !== contents.pid || current.acquiredAt !== contents.acquiredAt) return;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort.
      }
    },
  };
  return handle;
}

/**
 * Acquire the on-disk repo lock, running `work` under it with an automatic
 * heartbeat and guaranteed release (success or failure). Polls at `pollMs`
 * intervals while the lock is held by someone else (or is a fresh, non-stale
 * hold) — this is the primitive every main-checkout writer (merge, queue
 * rebase, scanner) should call so the same lockfile serializes ALL of them,
 * regardless of process.
 */
export async function withRepoLock<T>(
  repoPath: string,
  holder: string,
  work: () => Promise<T>,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const pollMs = opts.pollMs ?? 1000;
  const deadline = opts.timeoutMs != null ? Date.now() + opts.timeoutMs : null;

  let handle: RepoLockHandle | null = null;
  for (;;) {
    handle = tryAcquireRepoLock(repoPath, holder);
    if (handle) break;
    if (deadline != null && Date.now() >= deadline) {
      throw new Error(`[repo-lock] timed out waiting for lock on ${repoPath} (holder=${holder})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const heartbeatTimer = setInterval(() => handle?.heartbeat(), REPO_LOCK_HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(heartbeatTimer);
    handle.release();
  }
}
