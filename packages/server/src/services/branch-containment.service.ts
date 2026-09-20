import { checkBranchTipIsAncestor, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { resolveProjectRepo } from "../repositories/workspace-project-resolution.repository.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";

/**
 * #1205: is this workspace's branch fully CONTAINED in its base (0 commits ahead),
 * including the empty-branch case? Shared by the terminal-move guard (`issue move
 * Done` / PATCH / bulk update — see `terminal-move-guard.ts`) so a branch that was
 * never touched again after a hand-landed fix on the base does not strand its
 * issue on the open-workspace refusal until the next periodic reconciler tick.
 *
 * Deliberately narrower than `checkAlreadyMerged`: this only answers "is there
 * provably nothing left to merge on this branch", not the full multi-repo /
 * dirty-worktree merge-readiness question that endpoint owns. Best-effort — any
 * git failure resolves to `false` (never contained), since a guard must fail
 * closed: an unresolvable branch/base must still block the terminal move rather
 * than silently waving it through.
 */
export async function isWorkspaceBranchFullyContained(
  workspaceId: string,
  database: Database = db,
  gitDeps: {
    checkAncestor?: typeof checkBranchTipIsAncestor;
    countCommits?: typeof countUniqueCommits;
  } = {},
): Promise<boolean> {
  const ancestorCheck = gitDeps.checkAncestor ?? checkBranchTipIsAncestor;
  const commitCounter = gitDeps.countCommits ?? countUniqueCommits;
  try {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace || workspace.isDirect || !workspace.branch) return false;

    const { repoPath, defaultBranch } = await resolveProjectRepo(workspaceId, database);
    const baseBranch = workspace.baseBranch || defaultBranch;
    if (!baseBranch) return false;

    const ancestry = await ancestorCheck(repoPath, workspace.branch, baseBranch, workspace.workingDir ?? undefined);
    if (ancestry.branchSha === null || !ancestry.isAncestor) return false;

    const uniqueCommits = await commitCounter(repoPath, ancestry.baseSha, ancestry.branchSha);
    return uniqueCommits === 0;
  } catch {
    return false;
  }
}
