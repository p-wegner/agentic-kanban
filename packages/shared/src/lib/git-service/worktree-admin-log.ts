import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Instrumentation for every worktree ADMIN operation the board process runs (#1353).
 *
 * #1339 and #1342 serialized and age-bounded add/remove/prune, and the race still recurred, so
 * something we have not identified still removes a mid-provision worktree. This is the evidence
 * trail: one start line and one end line per `git worktree add|remove|prune`, naming the repo,
 * the path, the pid, whether the in-process admin lock was held, and the timing — plus a
 * watcher that logs when a new worktree's `.git` file first appears and, crucially, if it
 * later VANISHES. Lines are tagged `[worktree-admin]` so a recurrence is one grep.
 */

const lockHeld = new AsyncLocalStorage<true>();

/** Run `work` marking it as executing inside the worktree admin lock. */
export function runAsLockHolder<T>(work: () => Promise<T>): Promise<T> {
  return lockHeld.run(true, work);
}

export function isWorktreeAdminLockHeld(): boolean {
  return lockHeld.getStore() === true;
}

export type WorktreeAdminOp = "add" | "remove" | "prune";

/** Run one git worktree admin command, logging start/end with lock + pid context. */
export async function loggedWorktreeAdmin<T>(
  op: WorktreeAdminOp,
  repoPath: string,
  worktreePath: string | null,
  run: () => Promise<T>,
  extra = "",
): Promise<T> {
  const lock = isWorktreeAdminLockHeld() ? "yes" : "no";
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const head = `op=${op} repo=${repoPath} path=${worktreePath ?? "-"} pid=${process.pid} lock=${lock}${extra ? ` ${extra}` : ""}`;
  console.log(`[worktree-admin] start ${head} startedAt=${startedAt}`);
  try {
    const result = await run();
    console.log(`[worktree-admin] end ${head} ok=true durationMs=${Date.now() - t0} endedAt=${new Date().toISOString()}`);
    return result;
  } catch (err) {
    console.log(`[worktree-admin] end ${head} ok=false durationMs=${Date.now() - t0} endedAt=${new Date().toISOString()} error=${String(err).slice(0, 200)}`);
    throw err;
  }
}

const WATCH_INTERVAL_MS = 250;
const WATCH_MAX_MS = 5 * 60 * 1000;

/**
 * Log when `<worktreePath>/.git` first exists, and if it disappears afterwards. Best-effort,
 * unref'd, bounded; never throws. Disabled under vitest unless `force` (tests opt in).
 */
export function watchWorktreeGitFile(worktreePath: string, nowMs: number = Date.now(), force = false): void {
  if (!force && process.env.VITEST) return;
  const gitFile = join(worktreePath, ".git");
  const t0 = nowMs;
  let seen = false;
  const timer = setInterval(() => {
    try {
      const present = existsSync(gitFile);
      if (present && !seen) {
        seen = true;
        console.log(`[worktree-admin] git-file-appeared path=${worktreePath} pid=${process.pid} afterMs=${Date.now() - t0}`);
      } else if (!present && seen) {
        console.log(`[worktree-admin] git-file-VANISHED path=${worktreePath} pid=${process.pid} afterMs=${Date.now() - t0}`);
        clearInterval(timer);
        return;
      }
      if (Date.now() - t0 > WATCH_MAX_MS) clearInterval(timer);
    } catch {
      clearInterval(timer);
    }
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
}
