import { extractPendingWorkingTreeSync } from "@agentic-kanban/shared/lib/git-service";
import type { GitService } from "./workspace-internals.js";

/**
 * The ONE merge executor core (#945).
 *
 * Both entry paths that land a workspace branch on the base branch route their
 * git-touching steps through this module:
 *   - `doMerge` (workspace-merge.service.ts → workspace-merge-execution.service.ts):
 *     manual POST /merge, monitor auto-merge, merge-queue.
 *   - `autoMerge` (startup/merge-workflow.ts): review-exit foundational merge and
 *     fix-and-merge retry.
 *
 * The pipeline is: dirty-main guard (optional — the manual path runs it earlier via
 * resolveMergeState) → pre-merge backup (non-fatal) → SHA capture → git merge with
 * append-conflict auto-resolution (#763) → post-merge ancestry verification.
 * Caller-specific behavior (error wrapping, event/butler emission, merge-attempt
 * recording, status writes) stays with the caller via the hook parameters, so both
 * paths keep their externally observable semantics while the git operations exist
 * exactly once.
 */

export type MergeCoreResult = {
  /** Raw output of gitService.mergeBranch. */
  mergeOutput: string;
  /** HEAD of the base checkout after the merge ("" if revParse failed). */
  mergeCommitSha: string;
  /** HEAD of the base checkout before the merge ("" if revParse failed). */
  preMergeHead: string;
  /** Tip of the feature branch before the merge ("" if revParse failed). */
  mergedHeadSha: string;
  /** SHA to pass to applyDeferredWorkingTreeSync (only when deferWorkingTreeSync). */
  pendingWorkingTreeSyncSha: string | null;
};

export type RunMergeCoreArgs = {
  repoPath: string;
  branch: string;
  targetBranch: string;
  gitService: GitService;
  createBackup: (reason: string) => Promise<unknown>;
  /**
   * doMerge defers the working-tree sync (git reset --hard) to post-response cleanup
   * (#686); autoMerge syncs inline. When false the option is omitted entirely so the
   * git service sees the exact same options object as before the unification.
   */
  deferWorkingTreeSync: boolean;
  /**
   * When set, the core runs the dirty-main guard itself and throws the returned error
   * (autoMerge). The manual path runs the same check earlier in its pre-flight state
   * machine (resolveMergeState → getDirtyMainFiles) and passes undefined here.
   */
  onDirtyMain?: (uncommittedFiles: string[]) => Error;
  /**
   * Invoked when gitService.mergeBranch throws; must return the error to throw
   * (after any recording side effects). Default: rethrow the raw error.
   */
  onMergeError?: (err: unknown) => Promise<Error> | Error;
  /** Builds the error thrown when the post-merge ancestry invariant fails. */
  makeAncestryError: (branch: string, targetBranch: string) => Error;
};

/**
 * Dirty-main guard primitive: list uncommitted tracked changes in the main checkout.
 * Shared by resolveMergeState (manual path pre-flight) and runMergeCore (autoMerge)
 * so the guard's git call exists once.
 */
export async function getDirtyMainFiles(repoPath: string, gitService: GitService): Promise<string[]> {
  if (typeof gitService.getUncommittedTrackedChanges !== "function") return [];
  return gitService.getUncommittedTrackedChanges(repoPath);
}

export async function runMergeCore(args: RunMergeCoreArgs): Promise<MergeCoreResult> {
  const { repoPath, branch, targetBranch, gitService } = args;

  if (args.onDirtyMain) {
    const uncommitted = await getDirtyMainFiles(repoPath, gitService);
    if (uncommitted.length > 0) {
      throw args.onDirtyMain(uncommitted);
    }
  }

  // Mandatory pre-merge backup. Non-fatal: must not block a legit merge.
  try {
    await args.createBackup("pre-merge");
  } catch (err) {
    console.warn("[backup] pre-merge backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  const preMergeHead = await revParseSafe(repoPath, "HEAD", gitService);
  // Capture the feature branch tip BEFORE the merge — post-merge cleanup deletes
  // the branch ref, but this commit stays reachable from the default branch, so
  // the merged-commits panel can resolve baseCommitSha..mergedHeadSha afterwards.
  const mergedHeadSha = await revParseSafe(repoPath, branch, gitService);

  let mergeOutput: string;
  try {
    mergeOutput = await gitService.mergeBranch(repoPath, branch, targetBranch, {
      // #763: auto-resolve pure-append hot-file conflicts (a wave of tickets all
      // appending to one shared smoke test / log) by concatenating both tails,
      // instead of failing and forcing the cluster through fix-and-merge thrash.
      // Non-append conflicts still throw and route to fix-and-merge as before.
      autoResolveAppendConflicts: true,
      ...(args.deferWorkingTreeSync ? { deferWorkingTreeSync: true } : {}),
    });
  } catch (err) {
    if (args.onMergeError) throw await args.onMergeError(err);
    throw err;
  }

  // mergeBranch with deferWorkingTreeSync skips git reset --hard during the request.
  // Extract the pending SHA so post-merge cleanup can apply it after the response is sent.
  const pendingWorkingTreeSyncSha = extractPendingWorkingTreeSync(mergeOutput);
  const mergeCommitSha = await revParseSafe(repoPath, "HEAD", gitService);

  // Post-merge invariant: verify the branch tip is now reachable from target.
  // If not, the git merge did not actually land the work (e.g. plumbing anomaly
  // or interrupted ref update) — refuse to set Done so the scanner can catch it.
  const postMergeAncestry = await gitService.checkBranchTipIsAncestor(repoPath, branch, targetBranch);
  if (!postMergeAncestry.isAncestor) {
    throw args.makeAncestryError(branch, targetBranch);
  }

  return { mergeOutput, mergeCommitSha, preMergeHead, mergedHeadSha, pendingWorkingTreeSyncSha };
}

/**
 * Shared post-merge git cleanup: remove the worktree and delete the merged branch.
 * Both entry paths run these best-effort; only the failure handling differs
 * (doMerge records recoverable warnings + persists them, autoMerge is silent),
 * so that stays with the caller via the hooks.
 */
export async function cleanupMergedWorktreeAndBranch(args: {
  repoPath: string;
  workingDir: string | null | undefined;
  branch: string;
  gitService: GitService;
  onRemoveWorktreeError?: (err: unknown) => void | Promise<void>;
  onBranchDeleted?: () => void;
  onDeleteBranchError?: (err: unknown) => void;
}): Promise<void> {
  if (args.workingDir) {
    try {
      await args.gitService.removeWorktree(args.repoPath, args.workingDir);
    } catch (err) {
      await args.onRemoveWorktreeError?.(err);
    }
  }
  try {
    await args.gitService.deleteBranch(args.repoPath, args.branch);
    args.onBranchDeleted?.();
  } catch (err) {
    args.onDeleteBranchError?.(err);
  }
}

async function revParseSafe(repoPath: string, ref: string, gitService: GitService): Promise<string> {
  try {
    return await gitService.revParse(repoPath, ref);
  } catch {
    return "";
  }
}
