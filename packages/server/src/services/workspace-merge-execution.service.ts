import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { moveIssueToDone, resolveProjectId, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { WorkspaceError, type GitService } from "./workspace-internals.js";
import type { RecordMergeAttempt } from "./workspace-merge-prevalidation.service.js";

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

  await createPreMergeBackup(args.createBackup);
  const preMergeHead = await revParseSafe(repoPath, "HEAD", gitService);
  const mergeResult = await mergeBranchOrThrow(args);
  const mergeCommitSha = await revParseSafe(repoPath, "HEAD", gitService);
  await verifyPostMergeAncestry(repoPath, workspace.branch, targetBranch, gitService);

  const now = new Date().toISOString();
  await stampMergedAtEarly(id, now, database);
  await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now, mergedAt: now, readyForMerge: false }, database);
  await moveIssueToDone(id, workspace.issueId, now, database);
  await args.recordMergeAttempt(
    workspace,
    "merged",
    `Merged ${workspace.branch} into ${targetBranch}${mergeCommitSha ? ` at ${mergeCommitSha}` : ""}.`,
    { targetBranch, commitSha: mergeCommitSha || null, mergedAt: now, mergeOutput: mergeResult },
    now,
  );

  const projectId = await resolveProjectId(id, database);
  if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

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
      projectId,
    },
  };
}

async function createPreMergeBackup(createBackup: (reason: string) => Promise<unknown>): Promise<void> {
  try {
    await createBackup("pre-merge");
  } catch (err) {
    console.warn("[backup] pre-merge backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

async function revParseSafe(repoPath: string, ref: string, gitService: GitService): Promise<string> {
  try {
    return await gitService.revParse(repoPath, ref);
  } catch {
    return "";
  }
}

async function mergeBranchOrThrow(args: {
  workspace: typeof workspaces.$inferSelect;
  repoPath: string;
  targetBranch: string;
  gitService: GitService;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<string> {
  const { workspace, repoPath, targetBranch, gitService } = args;
  try {
    return await gitService.mergeBranch(repoPath, workspace.branch, targetBranch);
  } catch (err) {
    await args.recordMergeAttempt(
      workspace,
      "conflict",
      `Merge failed while merging ${workspace.branch} into ${targetBranch}: ${err instanceof Error ? err.message : String(err)}`,
      { step: "git-merge", targetBranch },
    );
    throw new WorkspaceError(
      `Merge failed (git-merge step): ${err instanceof Error ? err.message : String(err)}`,
      "CONFLICT",
      { mergeReason: "conflict", step: "git-merge", branch: workspace.branch, targetBranch },
    );
  }
}

async function verifyPostMergeAncestry(
  repoPath: string,
  branch: string,
  targetBranch: string,
  gitService: GitService,
): Promise<void> {
  const postMergeAncestry = await gitService.checkBranchTipIsAncestor(repoPath, branch, targetBranch);
  if (!postMergeAncestry.isAncestor) {
    throw new WorkspaceError(
      `Post-merge invariant violated: branch '${branch}' is still not an ancestor of '${targetBranch}' after merge — refusing to move issue to Done`,
      "CONFLICT",
      { mergeReason: "post_merge_ancestry_check_failed", branch, targetBranch },
    );
  }
}

async function stampMergedAtEarly(id: string, now: string, database: Database): Promise<void> {
  try {
    await database.update(workspaces).set({ mergedAt: now, updatedAt: now }).where(eq(workspaces.id, id));
  } catch (err) {
    console.warn("[workspace-merge] early mergedAt stamp failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
