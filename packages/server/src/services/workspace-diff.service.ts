import type { Database } from "../db/index.js";
import * as realGitService from "./git.service.js";
import { getWorkspaceById, resolveProjectRepo } from "../repositories/workspace.repository.js";
import { getDiffComments } from "../repositories/session.repository.js";
import { parseDiffStats } from "./board-aggregation.service.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";

export function createWorkspaceDiffService(deps: {
  database: Database;
  gitService?: GitService;
}) {
  const { database } = deps;
  const gitService = deps.gitService ?? realGitService;

  async function getWorkspaceDiff(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir && !workspace.branch) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    let diff = "";
    let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    if (workspace.isDirect) {
      diff = workspace.workingDir
        ? await gitService.getWorkingTreeDiff(workspace.workingDir)
        : "";
    } else {
      let usedWorktree = false;
      if (workspace.workingDir) {
        try {
          diff = await gitService.getDiff(workspace.workingDir, baseBranch);
          conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
          usedWorktree = true;
        } catch {
          // Worktree directory exists but is not a valid git repo — fall through
        }
      }
      if (!usedWorktree) {
        if (workspace.branch) {
          diff = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
        } else {
          diff = "";
        }
      }
    }

    const stats = parseDiffStats(diff);
    const comments = await getDiffComments(id, undefined, database);
    console.log(`[workspace-service] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} conflicts=${conflicts?.hasConflicts ?? "n/a"} comments=${comments.length}`);
    return { diff, stats, comments, conflicts };
  }

  async function getConflicts(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      return { hasConflicts: false, conflictingFiles: [] };
    }

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    return gitService.detectConflicts(workspace.workingDir, baseBranch);
  }

  async function getLatestCommit(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) return { sha: null, message: null };
    const commit = await gitService.getLatestCommit(workspace.workingDir);
    return commit ?? { sha: null, message: null };
  }

  return { getWorkspaceDiff, getConflicts, getLatestCommit };
}
