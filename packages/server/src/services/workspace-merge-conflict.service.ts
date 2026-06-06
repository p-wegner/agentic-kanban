import { workspaces } from "@agentic-kanban/shared/schema";
import type { GitService } from "./workspace-internals.js";

export type WorkspaceMergeConflictResult =
  | { kind: "clear" }
  | { kind: "conflict"; conflictFiles: string[]; behindCount?: number };

export async function detectWorkspaceMergeConflicts(args: {
  workspace: typeof workspaces.$inferSelect;
  repoPath: string;
  baseBranch: string;
  gitService: GitService;
}): Promise<WorkspaceMergeConflictResult> {
  const { workspace, repoPath, baseBranch, gitService } = args;
  if (!workspace.workingDir) return { kind: "clear" };

  const behindCount = await countBehindCommitsSafe(repoPath, workspace.branch, baseBranch, gitService);
  if (behindCount > 0) {
    const rebaseResult = await gitService.rebaseOntoBase(
      workspace.workingDir,
      baseBranch,
      workspace.branch,
      { preferLocalBase: true },
    );
    if (!rebaseResult.success) {
      try {
        await gitService.abortRebase(workspace.workingDir);
      } catch {
        // Best-effort abort so the worktree remains usable for fix-and-merge.
      }
      return {
        kind: "conflict",
        conflictFiles: rebaseResult.conflictingFiles ?? [],
        behindCount,
      };
    }
  }

  const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
  if (conflicts.hasConflicts) {
    return {
      kind: "conflict",
      conflictFiles: conflicts.conflictingFiles,
    };
  }

  return { kind: "clear" };
}

async function countBehindCommitsSafe(
  repoPath: string,
  branch: string,
  baseBranch: string,
  gitService: GitService,
): Promise<number> {
  if (typeof gitService.countBehindCommits !== "function") return 0;
  try {
    return await gitService.countBehindCommits(repoPath, branch, baseBranch);
  } catch {
    return 0;
  }
}
