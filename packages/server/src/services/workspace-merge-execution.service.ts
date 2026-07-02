import type { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { WorkspaceError, type GitService } from "./workspace-internals.js";
import type { RecordMergeAttempt } from "./workspace-merge-prevalidation.service.js";
import { finalizeMergeCleanup } from "./merge-cleanup.service.js";
import { runMergeCore } from "./merge-executor.service.js";
import { stampWorkspaceMergedAt } from "../repositories/workspace-merge-execution.repository.js";

export type WorkspaceMergeExecutionResult = {
  response: {
    id: string;
    merged: true;
    baseBranch: string;
    mergeCommitSha?: string;
    baseHeadShaBefore?: string;
    baseHeadShaAfter?: string;
    mergeOutput: string;
  };
  postMergeContext: {
    preMergeHead: string;
    mergeResult: string;
    mergeCommitSha: string;
    projectId: string | null;
    /** SHA to pass to applyDeferredWorkingTreeSync after the HTTP response is flushed. */
    pendingWorkingTreeSyncSha: string | null;
  };
};

export async function executeWorkspaceMerge(args: {
  id: string;
  workspace: typeof workspaces.$inferSelect;
  repoPath: string;
  targetBranch: string;
  database: Database;
  boardEvents?: BoardEvents;
  gitService: GitService;
  createBackup: (reason: string) => Promise<unknown>;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<WorkspaceMergeExecutionResult> {
  const { id, workspace, repoPath, targetBranch, database, boardEvents, gitService } = args;
  console.log(`[workspace-service] merge: workspaceId=${id} branch=${workspace.branch} targetBranch=${targetBranch} repoPath=${repoPath}`);

  if (workspace.workingDir) {
    const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
    if (synced) {
      console.log(`[workspace-service] synced branch ${workspace.branch} to worktree HEAD`);
    }
  }

  // The git-touching pipeline (backup → SHA capture → merge with append-conflict
  // auto-resolution → post-merge ancestry verification) lives in the shared merge
  // executor core (#945) — the same core the autoMerge path runs. The dirty-main
  // guard already ran in resolveMergeState, so it is not repeated here.
  const core = await runMergeCore({
    repoPath,
    branch: workspace.branch,
    targetBranch,
    gitService,
    createBackup: args.createBackup,
    deferWorkingTreeSync: true,
    onMergeError: async (err) => {
      await args.recordMergeAttempt(
        workspace,
        "conflict",
        `Merge failed while merging ${workspace.branch} into ${targetBranch}: ${err instanceof Error ? err.message : String(err)}`,
        { step: "git-merge", targetBranch },
      );
      return new WorkspaceError(
        `Merge failed (git-merge step): ${err instanceof Error ? err.message : String(err)}`,
        "CONFLICT",
        { mergeReason: "conflict", step: "git-merge", branch: workspace.branch, targetBranch },
      );
    },
    makeAncestryError: (branch, target) =>
      new WorkspaceError(
        `Post-merge invariant violated: branch '${branch}' is still not an ancestor of '${target}' after merge — refusing to move issue to Done`,
        "CONFLICT",
        { mergeReason: "post_merge_ancestry_check_failed", branch, targetBranch: target },
      ),
  });
  const { preMergeHead, mergedHeadSha, mergeCommitSha, pendingWorkingTreeSyncSha } = core;
  const mergeResult = core.mergeOutput;

  const now = new Date().toISOString();
  await stampMergedAtEarly(id, now, mergedHeadSha || null, database);
  const finalized = await finalizeMergeCleanup({
    database,
    boardEvents,
    workspaceId: id,
    issueId: workspace.issueId,
    now,
    closedAt: now,
    mergedAt: now,
    workingDir: null,
  });
  await args.recordMergeAttempt(
    workspace,
    "merged",
    `Merged ${workspace.branch} into ${targetBranch}${mergeCommitSha ? ` at ${mergeCommitSha}` : ""}.`,
    { targetBranch, commitSha: mergeCommitSha || null, mergedAt: now, mergeOutput: mergeResult },
    now,
  );

  return {
    response: {
      id,
      merged: true,
      baseBranch: targetBranch,
      mergeCommitSha: mergeCommitSha || undefined,
      baseHeadShaBefore: preMergeHead || undefined,
      baseHeadShaAfter: mergeCommitSha || undefined,
      mergeOutput: mergeResult,
    },
    postMergeContext: {
      preMergeHead,
      mergeResult,
      mergeCommitSha,
      projectId: finalized.projectId,
      pendingWorkingTreeSyncSha,
    },
  };
}

async function stampMergedAtEarly(id: string, now: string, mergedHeadSha: string | null, database: Database): Promise<void> {
  try {
    await stampWorkspaceMergedAt(id, now, mergedHeadSha, database);
  } catch (err) {
    console.warn("[workspace-merge] early mergedAt stamp failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
