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
 * longer exists.
 *
 * The same probe cuts the other way too: a same-host holder whose pid is
 * PROVABLY alive is NOT reclaimed even when its heartbeat has gone stale. A
 * stale heartbeat is only presumptive evidence of death, and that presumption
 * is wrong for a holder that is mid-`git` but failed to refresh the file in
 * time (blocked event loop, system sleep/resume, an AV-locked write on
 * Windows) — reclaiming there is how a live lock gets stolen. Bounded by
 * {@link REPO_LOCK_LIVE_HOLDER_MAX_MS} so a recycled pid can never wedge the
 * repo forever. A cross-host holder, an EPERM pid, or an unreadable holder is
 * neither confirmed dead nor confirmed alive, so those keep the original
 * heartbeat-staleness behaviour.
 */

const LOCK_FILE_NAME = "agentic-kanban-merge.lock";

/** A heartbeat older than this means the holder is presumed dead (crashed, hot-reloaded, killed). */
export const REPO_LOCK_STALE_MS = 60 * 1000;

/**
 * Upper bound on how long a PROVABLY-ALIVE same-host holder can block reclaim on a stale
 * heartbeat alone.
 *
 * `process.kill(pid, 0)` proving a pid alive normally means the holder is still working and its
 * heartbeat merely lagged (a blocked event loop, a system sleep/resume, an AV-locked lockfile
 * write on Windows) — reclaiming there steals the lock out from under a running `git`. But a pid
 * can also be RECYCLED (after a reboot the recorded pid may belong to an unrelated process),
 * and an unconditional refusal would then wedge the repo permanently with no recovery path but
 * deleting the file by hand. This bound keeps the safe case safe while guaranteeing the lock is
 * always eventually reclaimable. Generous on purpose: it must exceed any legitimate hold
 * (`MERGE_QUEUE_REPO_LOCK_TIMEOUT_MS` is 90 minutes).
 */
export const REPO_LOCK_LIVE_HOLDER_MAX_MS = 2 * 60 * 60 * 1000;

/** How often a held lock's heartbeat is refreshed while work is in flight. */
export const REPO_LOCK_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/**
 * Default bound for {@link withRepoLock}/{@link waitForRepoLock} when a caller names none
 * (#230 — the old default was "wait forever"). Generous on purpose: it must exceed a
 * legitimately slow holder (a merge running a full verify gate, 30-45 min), so it only
 * fires for a holder that is genuinely wedged rather than merely slow.
 */
export const REPO_LOCK_DEFAULT_WAIT_MS = 90 * 60 * 1000;

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
  return probeHolderProcess(contents) === "dead";
}

/**
 * True only when we can be CONFIDENT the holder is still running: same host, and
 * `process.kill(pid, 0)` succeeded outright. A cross-host holder, an EPERM (a pid owned by
 * another user — existing behaviour treats that as unprovable), or any unexpected error is NOT
 * confirmation, so those keep the pre-existing heartbeat-staleness reclaim path.
 */
function isProcessConfirmedAlive(contents: RepoLockContents): boolean {
  return probeHolderProcess(contents) === "alive";
}

/**
 * Tri-state probe of the recorded holder pid. The three outcomes drive three different
 * decisions, which is why this cannot be a boolean:
 *  - `"dead"`   → same host, ESRCH: reclaim IMMEDIATELY, even inside the staleness window (#207).
 *  - `"alive"`  → same host, signal delivered: REFUSE reclaim; the holder is mid-`git` and its
 *                 heartbeat merely lagged.
 *  - `"unknown"`→ cross-host, EPERM, or an unexpected error: fall back to heartbeat staleness,
 *                 exactly as before.
 */
function probeHolderProcess(contents: RepoLockContents): "dead" | "alive" | "unknown" {
  if (contents.hostname !== hostname()) return "unknown";
  try {
    process.kill(contents.pid, 0);
    return "alive";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

export interface RepoLockStatus {
  path: string;
  contents: RepoLockContents;
  ageMs: number;
  isStale: boolean;
  /** Same-host holder whose pid no longer exists — reclaimable even if not yet stale. See {@link isProcessConfirmedDead}. */
  ownerProcessDead: boolean;
  /**
   * Same-host holder whose pid is PROVABLY still running. Such a lock is not reclaimed even
   * when its heartbeat is stale — see {@link isProcessConfirmedAlive} and
   * {@link REPO_LOCK_LIVE_HOLDER_MAX_MS}.
   */
  ownerProcessAlive: boolean;
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
    ownerProcessAlive: isProcessConfirmedAlive(contents),
  };
}

/**
 * Force-remove a lock only if it is still the exact stale entry we inspected
 * (contents match) — prevents a TOCTOU race where the holder heartbeats or a
 * new holder acquires between inspection and recovery.
 */
function recoverIfUnchanged(
  lockPath: string,
  expected: RepoLockContents,
): { outcome: "recovered" } | { outcome: "changed" } | { outcome: "error"; code: string; message: string } {
  const current = readLockContents(lockPath);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return { outcome: "changed" };
  try {
    rmSync(lockPath, { force: true });
    return { outcome: "recovered" };
  } catch (err) {
    // NOT contention: we own the right to remove this stale file and the filesystem
    // said no (EPERM/EACCES/EBUSY). Reported as UNAVAILABLE so a caller fails with a
    // real reason instead of polling forever behind an unremovable file (#230).
    return { outcome: "error", code: errnoCode(err) ?? "UNKNOWN", message: errMessage(err) };
  }
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why one `tryAcquireRepoLock` attempt did not produce a handle (#230).
 *
 * The two reasons are operationally OPPOSITE and used to collapse into a single
 * `null`, with a bare `catch { return null }` around the lockfile write mislabelling
 * a permission/IO failure as lock contention:
 *  - `contended` — somebody else legitimately holds the lock (or won the race to it).
 *    Waiting is correct; it will be released.
 *  - `unavailable` — this path cannot be locked AT ALL: no `.git` directory, a
 *    read-only/permission-denied location, an unremovable stale lockfile. Waiting can
 *    never succeed, so a caller that polls hangs forever with no error and no log line
 *    (the measured #230 symptom: a merge that HUNG instead of failing). Callers must
 *    fail fast on this.
 */
export type RepoLockAttempt =
  | { outcome: "acquired"; handle: RepoLockHandle }
  | { outcome: "contended"; reason: string; heldBy?: RepoLockContents }
  | { outcome: "unavailable"; reason: string; code: string };

/** Thrown by the bounded waiters when the repo path cannot be locked at all (#230). */
export class RepoLockUnavailableError extends Error {
  constructor(readonly repoPath: string, readonly holder: string, readonly code: string, reason: string) {
    super(`[repo-lock] cannot lock ${repoPath} (holder=${holder}): ${reason}`);
    this.name = "RepoLockUnavailableError";
  }
}

/**
 * Attempt to acquire the on-disk repo lock exactly once (no waiting/retry —
 * callers that want to wait for an in-flight holder should poll via
 * {@link inspectRepoLock} or layer their own retry/backoff on top).
 *
 * Returns a handle on success, or `null` if a live (non-stale, live-process)
 * lock is held by someone else — or if the holder's heartbeat IS stale but its
 * same-host pid is provably alive (see {@link REPO_LOCK_LIVE_HOLDER_MAX_MS}).
 * A stale lock (heartbeat older than
 * {@link REPO_LOCK_STALE_MS}) is recovered automatically before the
 * acquisition attempt — as is a same-host lock whose holder pid is confirmed
 * dead ({@link isProcessConfirmedDead}), even if its heartbeat isn't stale
 * yet (#207: a killed holder's heartbeat freezes rather than advancing, so
 * without this check every merge on the repo would block for the full
 * staleness window behind a holder that no longer exists).
 */
export function tryAcquireRepoLock(repoPath: string, holder: string, nowMs = Date.now()): RepoLockHandle | null {
  const attempt = attemptRepoLock(repoPath, holder, nowMs);
  return attempt.outcome === "acquired" ? attempt.handle : null;
}

/**
 * The same single acquisition attempt as {@link tryAcquireRepoLock}, but reporting WHY
 * it failed — see {@link RepoLockAttempt}. This is the form every waiting caller should
 * use: `contended` means keep waiting, `unavailable` means fail now (#230).
 */
export function attemptRepoLock(repoPath: string, holder: string, nowMs = Date.now()): RepoLockAttempt {
  const lockPath = lockPathFor(repoPath);
  const existing = inspectRepoLock(repoPath, nowMs);
  if (existing) {
    if (!existing.isStale && !existing.ownerProcessDead) {
      return {
        outcome: "contended",
        reason: `held by ${existing.contents.holder} pid=${existing.contents.pid} host=${existing.contents.hostname} (heartbeat age ${Math.round(existing.ageMs / 1000)}s)`,
        heldBy: existing.contents,
      };
    }
    // A stale heartbeat is only PRESUMPTIVE evidence that the holder is gone. When the holder is
    // same-host and its pid is provably alive, that presumption is simply wrong: the process is
    // mid-`git` and merely failed to refresh the file in time (blocked event loop, system
    // sleep/resume, an AV-locked write on Windows). Reclaiming there hands a second writer the
    // same repo while the first is still working — the exact corruption the lock exists to
    // prevent. `isProcessConfirmedDead` only ever SHORTENED the wait, so nothing used to block
    // this. Bounded by REPO_LOCK_LIVE_HOLDER_MAX_MS so a recycled pid cannot wedge the repo.
    if (existing.ownerProcessAlive && existing.ageMs <= REPO_LOCK_LIVE_HOLDER_MAX_MS) {
      console.warn(
        `[repo-lock] refusing to reclaim stale-heartbeat lock at ${lockPath}: holder pid=${existing.contents.pid} is ALIVE on this host ` +
          `(heartbeat age=${Math.round(existing.ageMs / 1000)}s, holder=${existing.contents.holder}) — waiting rather than stealing a live lock`,
      );
      return {
        outcome: "contended",
        reason: `stale-heartbeat lock refused: holder pid=${existing.contents.pid} is ALIVE on this host (heartbeat age ${Math.round(existing.ageMs / 1000)}s)`,
        heldBy: existing.contents,
      };
    }
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
    const recovery = recoverIfUnchanged(lockPath, existing.contents);
    if (recovery.outcome === "changed") {
      // Someone else recovered/reacquired first — refuse rather than clobber them.
      return { outcome: "contended", reason: "another acquirer recovered or reacquired the stale lock first" };
    }
    if (recovery.outcome === "error") {
      return {
        outcome: "unavailable",
        code: recovery.code,
        reason: `the stale lockfile ${lockPath} could not be removed (${recovery.code}: ${recovery.message}) — waiting cannot fix this`,
      };
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
    return {
      outcome: "unavailable",
      code: "ENOENT",
      reason: `${join(repoPath, ".git")} does not exist (repoPath misconfigured?) — no amount of waiting will make this path lockable`,
    };
  }

  try {
    writeFileSync(lockPath, JSON.stringify(contents), { flag: "wx" });
  } catch (err) {
    // EEXIST is the ONE contention case here: we lost the race to another acquirer
    // between our staleness check and the `wx` write. Every other errno — EACCES,
    // EPERM, EROFS, ENOENT, EISDIR — means the path cannot be locked at all, and the
    // old bare `catch { return null }` reported those as contention, which is what
    // made a merge poll forever instead of failing (#230).
    const code = errnoCode(err);
    if (code === "EEXIST") {
      return { outcome: "contended", reason: "lost the race to another acquirer (EEXIST)" };
    }
    console.warn(`[repo-lock] cannot write ${lockPath} (${code ?? "UNKNOWN"}): ${errMessage(err)}`);
    return {
      outcome: "unavailable",
      code: code ?? "UNKNOWN",
      reason: `the lockfile ${lockPath} could not be written (${code ?? "UNKNOWN"}: ${errMessage(err)}) — waiting cannot fix this`,
    };
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
  return { outcome: "acquired", handle };
}

/**
 * Everything the bounded waiter needs from the outside world, so the BOUND ITSELF is
 * testable (#230). With the timeout and the clock as module-private constants and a real
 * `setTimeout`, no test could fail if the bound were removed — the only way to observe it
 * was to wait out 90 real minutes. `now`/`sleep`/`attempt` are injected here so a test can
 * drive a virtual clock past the deadline in microseconds.
 */
export interface RepoLockWaitOptions {
  /** Hard upper bound on waiting. Required — an unbounded wait is the #230 defect. */
  timeoutMs: number;
  pollMs?: number;
  /** Clock source. Injected so a test can advance time without waiting. */
  now?: () => number;
  /** Sleep between polls. Injected so a test's virtual clock can advance instead. */
  sleep?: (ms: number) => Promise<void>;
  /** Acquisition attempt. Injected so a test can script contended/unavailable outcomes. */
  attempt?: (repoPath: string, holder: string) => RepoLockAttempt;
  /** Called on each unsuccessful CONTENDED attempt (periodic logging lives in callers). */
  onContended?: (attempt: Extract<RepoLockAttempt, { outcome: "contended" }>, waitedMs: number) => void;
}

/**
 * Wait for the on-disk repo lock, bounded, and FAIL FAST when the path cannot be locked
 * at all (#230). The single implementation behind every waiting caller — `withRepoLock`
 * here, `acquireOnDiskRepoLock` in `workspace-internals.ts`, and the merge-queue's two
 * sites — so the classification and the bound cannot drift between them.
 *
 * Throws {@link RepoLockUnavailableError} immediately on an `unavailable` attempt (a
 * missing `.git`, a permission/IO error, an unremovable stale lockfile): those can never
 * resolve by waiting, and treating them as contention is exactly what turned a broken
 * repoPath into a merge that hung with no error and no log line.
 */
export async function waitForRepoLock(
  repoPath: string,
  holder: string,
  opts: RepoLockWaitOptions,
): Promise<RepoLockHandle> {
  const pollMs = opts.pollMs ?? 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attemptFn = opts.attempt ?? attemptRepoLock;

  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  for (;;) {
    const attempt = attemptFn(repoPath, holder);
    if (attempt.outcome === "acquired") return attempt.handle;
    if (attempt.outcome === "unavailable") {
      throw new RepoLockUnavailableError(repoPath, holder, attempt.code, attempt.reason);
    }
    opts.onContended?.(attempt, now() - startedAt);
    if (now() >= deadline) {
      throw new Error(
        `[repo-lock] timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for the lock on ${repoPath} ` +
          `(holder=${holder}) — ${attempt.reason}`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Acquire the on-disk repo lock, running `work` under it with an automatic
 * heartbeat and guaranteed release (success or failure). Polls at `pollMs`
 * intervals while the lock is held by someone else (or is a fresh, non-stale
 * hold) — this is the primitive every main-checkout writer (merge, queue
 * rebase, scanner) should call so the same lockfile serializes ALL of them,
 * regardless of process.
 *
 * `timeoutMs` defaults to {@link REPO_LOCK_DEFAULT_WAIT_MS} rather than to "forever":
 * an unbounded wait is the #230 defect. An `unavailable` repo path (no `.git`,
 * permission denied) throws {@link RepoLockUnavailableError} immediately.
 */
export async function withRepoLock<T>(
  repoPath: string,
  holder: string,
  work: () => Promise<T>,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const handle = await waitForRepoLock(repoPath, holder, {
    timeoutMs: opts.timeoutMs ?? REPO_LOCK_DEFAULT_WAIT_MS,
    pollMs: opts.pollMs ?? 1000,
  });

  const heartbeatTimer = setInterval(() => handle.heartbeat(), REPO_LOCK_HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(heartbeatTimer);
    handle.release();
  }
}
