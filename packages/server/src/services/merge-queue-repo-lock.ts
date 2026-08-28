/**
 * Repo-lock acquisition for the merge queue — split out of `merge-queue.service.ts` (#906
 * fix-and-merge god-module split) so both it and `merge-queue-train.ts` can depend on this
 * without the two importing each other.
 */
import { RepoLockUnavailableError, waitForRepoLock } from "@agentic-kanban/shared/lib/repo-lock";
import type { RepoLockHandle, RepoLockWaitOptions } from "@agentic-kanban/shared/lib/repo-lock";

/**
 * How long a queue member waits for the repo lock before failing loudly (#230).
 * Must exceed a legitimate holder's verify gate — see the matching constant in
 * `workspace-internals.ts`. Exported so a test can drive the bound (a module-private
 * const with a module-private clock made it unfalsifiable).
 */
export const MERGE_QUEUE_REPO_LOCK_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Acquire the repo lock for a queue step: bounded, periodically logged, and failing FAST
 * when the path cannot be locked at all rather than polling a permanently-unlockable
 * repoPath as if it were merely busy (#230). Both queue sites go through this one helper
 * so the classification cannot drift between them.
 */
export async function acquireQueueRepoLock(
  repoPath: string,
  holder: string,
  opts: Partial<RepoLockWaitOptions> = {},
): Promise<RepoLockHandle> {
  const timeoutMs = opts.timeoutMs ?? MERGE_QUEUE_REPO_LOCK_TIMEOUT_MS;
  let lastLoggedMs = 0;
  try {
    return await waitForRepoLock(repoPath, holder, {
      ...opts,
      timeoutMs,
      pollMs: opts.pollMs ?? 500,
      onContended: (attempt, waitedMs) => {
        opts.onContended?.(attempt, waitedMs);
        if (waitedMs - lastLoggedMs < 60_000) return;
        lastLoggedMs = waitedMs;
        console.warn(
          `[merge-queue] still waiting for the repo lock on ${repoPath} (${holder}) after ` +
            `${Math.round(waitedMs / 1000)}s of ${Math.round(timeoutMs / 1000)}s — ${attempt.reason}`,
        );
      },
    });
  } catch (err) {
    if (err instanceof RepoLockUnavailableError) {
      throw new Error(
        `[merge-queue] cannot lock ${repoPath} (${holder}) — ${err.message}. ` +
          `This is not lock contention (code ${err.code}); waiting would never have succeeded.`,
      );
    }
    throw err;
  }
}
