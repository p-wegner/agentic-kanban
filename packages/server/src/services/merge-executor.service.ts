import { applyDeferredWorkingTreeSync, extractPendingWorkingTreeSync, getDeletedPathsVsHead } from "@agentic-kanban/shared/lib/git-service";
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

  await assertMainCheckoutReflectsMerge({
    repoPath,
    branch,
    mergeCommitSha,
    // Nothing to assert while a sync is still owed: the caller explicitly took ownership
    // of the window. Only a caller that syncs inline can be held to a clean checkout.
    skip: pendingWorkingTreeSyncSha !== null,
  });

  return { mergeOutput, mergeCommitSha, preMergeHead, mergedHeadSha, pendingWorkingTreeSyncSha };
}

/**
 * #350: after a merge reports success, the MAIN checkout must not be left undoing it.
 *
 * The observed corruption was exactly the merged paths showing as `D  path` — staged for
 * deletion, absent from disk, present in HEAD — for ~32 seconds after each pm-pipeline
 * auto-merge. Two downstream failures followed, both observed: the pm-pipeline planner reads
 * step artifacts from the main checkout and did not raise a gate because the evidence was
 * missing, and a dirty index is a hard stop for the board's own merge preconditions, so the
 * NEXT merge would fail pointing at the wrong ticket.
 *
 * The ticket's own hypothesis (a worktree prune running against the main checkout's index)
 * is WRONG and is retracted here: the window is designed-in. `mergeBranch` advances
 * `refs/heads/<base>` by `update-ref` while that branch is checked out, and the working-tree
 * `reset --hard` that reconciles index+disk with the new HEAD is a SEPARATE step. Whoever
 * defers that step owns a window in which the checkout contradicts HEAD.
 *
 * This assertion therefore runs SYNCHRONOUSLY, inside the merge path, before the merge is
 * reported complete — which is the one placement that can catch it. A check that runs
 * asynchronously or a moment later finds a clean tree and always passes, which is precisely
 * why #296's retry hardening looked like it worked while the bug survived.
 *
 * On detection it repairs once (the same hard sync the deferred path would have done) and
 * re-checks. If the checkout still contradicts HEAD, it THROWS: reporting success while the
 * artifacts are missing from disk is the failure mode, so a loud failure is strictly better.
 */
async function assertMainCheckoutReflectsMerge(args: {
  repoPath: string;
  branch: string;
  mergeCommitSha: string;
  skip: boolean;
}): Promise<void> {
  if (args.skip) return;
  let deleted = await getDeletedPathsVsHead(args.repoPath);
  if (deleted.length === 0) return;
  console.warn(
    `[merge-core] #350: main checkout ${args.repoPath} shows ${deleted.length} path(s) deleted relative to HEAD `
    + `immediately after merging '${args.branch}' — repairing before reporting success: ${deleted.slice(0, 5).join(", ")}`,
  );
  if (args.mergeCommitSha) {
    try {
      await applyDeferredWorkingTreeSync(args.repoPath, args.mergeCommitSha);
    } catch (err) {
      console.warn("[merge-core] #350 repair sync failed:", err instanceof Error ? err.message : String(err));
    }
  }
  deleted = await getDeletedPathsVsHead(args.repoPath);
  if (deleted.length === 0) return;
  throw new Error(
    `Post-merge checkout invariant violated (#350): after merging '${args.branch}', the main checkout at `
    + `${args.repoPath} still has ${deleted.length} tracked path(s) deleted relative to HEAD `
    + `(${deleted.slice(0, 10).join(", ")}${deleted.length > 10 ? ", …" : ""}). The merge commit is correct but the `
    + `checkout undoes it — anything reading artifacts from this checkout will see them missing. `
    + `Recover with: git restore --source=HEAD --staged --worktree -- .`,
  );
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
