/**
 * Repo-lock acquisition for the merge queue — split out of `merge-queue.service.ts` (#906
 * fix-and-merge god-module split) so both it and `merge-queue-train.ts` can depend on this
 * without the two importing each other.
 */
import { RepoLockUnavailableError, waitForRepoLock } from "@agentic-kanban/shared/lib/repo-lock";
import type { RepoLockHandle, RepoLockAttempt, RepoLockWaitOptions } from "@agentic-kanban/shared/lib/repo-lock";

/**
 * How long a queue member waits for the repo lock before failing loudly (#230).
 * Must exceed a legitimate holder's verify gate — see the matching constant in
 * `workspace-internals.ts`. Exported so a test can drive the bound (a module-private
 * const with a module-private clock made it unfalsifiable).
 */
export const MERGE_QUEUE_REPO_LOCK_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * How long ONE release train may wait for the repo lock before it is abandoned rather than
 * kept polling (#1153). A train is cheap to re-assemble (a few `--no-ff` merges onto a fresh,
 * disposable ref — see `startup/merge-train-reconciler.ts`'s header), unlike a per-workspace
 * queue member whose 90-minute budget must outlast a legitimate holder's own verify gate. Left
 * at the shared 90-minute bound, a contended repo accumulated one 90-minute waiter per ~10-minute
 * batching-window release — nine unfinished trains queued three hours deep with none ever timing
 * out. Bounded shorter, an abandoned train is retried by the next window release (or the startup
 * reconciler) instead of silently occupying a wait slot for the full 90 minutes.
 */
export const MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A holder string this process can independently confirm/deny is still doing work, beyond
 * the pid/heartbeat the lock file itself carries (#1150). The train's live registry
 * (`merge-train-live-registry.ts`, keyed by label) is the only implementation today — it
 * answers "is a train job for this holder still registered in this process?" — and is
 * injected here rather than imported, so this helper stays free of a dependency on the train
 * module, which already imports IT. `undefined` means "cannot tell" (a holder this process
 * has no registry for), and the log line then falls back to naming just the pid, as before.
 */
export type HolderLivenessCheck = (holder: string) => boolean | undefined;

/**
 * The suffix a contended-wait log line carries about the CURRENT holder's own liveness (#1150).
 * A pid is alive for as long as the whole server is up, which says nothing about whether the
 * SPECIFIC job that acquired the lock is still the one running — so the line names the job's
 * evidence too. Pure, so a test can drive it without waiting a real minute for the first log.
 */
export function formatHolderLivenessEvidence(
  attempt: RepoLockAttempt,
  checkHolderLiveness: HolderLivenessCheck | undefined,
): string {
  const heldBy = attempt.outcome === "contended" ? attempt.heldBy : undefined;
  const liveness = heldBy && checkHolderLiveness ? checkHolderLiveness(heldBy.holder) : undefined;
  if (liveness === undefined) return "";
  return liveness
    ? " — that job IS still running in this process"
    : " — that job is NOT registered as running in this process (a stranded lock; the reconciler should reclaim it)";
}

/**
 * Acquire the repo lock for a queue step: bounded, periodically logged, and failing FAST
 * when the path cannot be locked at all rather than polling a permanently-unlockable
 * repoPath as if it were merely busy (#230). Both queue sites go through this one helper
 * so the classification cannot drift between them.
 */
export async function acquireQueueRepoLock(
  repoPath: string,
  holder: string,
  opts: Partial<RepoLockWaitOptions> & { checkHolderLiveness?: HolderLivenessCheck } = {},
): Promise<RepoLockHandle> {
  const timeoutMs = opts.timeoutMs ?? MERGE_QUEUE_REPO_LOCK_TIMEOUT_MS;
  const { checkHolderLiveness, ...waitOpts } = opts;
  let lastLoggedMs = 0;
  try {
    return await waitForRepoLock(repoPath, holder, {
      ...waitOpts,
      timeoutMs,
      pollMs: opts.pollMs ?? 500,
      onContended: (attempt, waitedMs) => {
        opts.onContended?.(attempt, waitedMs);
        if (waitedMs - lastLoggedMs < 60_000) return;
        lastLoggedMs = waitedMs;
        console.warn(
          `[merge-queue] still waiting for the repo lock on ${repoPath} (${holder}) after ` +
            `${Math.round(waitedMs / 1000)}s of ${Math.round(timeoutMs / 1000)}s — ${attempt.reason}` +
            formatHolderLivenessEvidence(attempt, checkHolderLiveness),
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
