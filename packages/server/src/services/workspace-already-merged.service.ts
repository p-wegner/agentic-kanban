import type { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import {
  resolveProjectRepo,
  getWorkspaceById,
} from "../repositories/workspace.repository.js";
import { getIssueNumberById } from "../repositories/workspace-merge.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./workspace-services.service.js";
import { cleanupSiblingWorktrees } from "./workspace-repos.service.js";
import { finalizeMergeCleanup } from "./merge-cleanup.service.js";
import {
  WorkspaceError,
  requireBaseBranch,
  listPendingSiblingMerges,
  type GitService,
} from "./workspace-internals.js";

export type AlreadyMergedCheck = {
  isAlreadyMerged: boolean;
  branch: string;
  baseBranch: string;
  mergeCommitSha: string | null;
  issueNumber: number | null;
  reason?: string;
};

/**
 * Check whether a workspace's branch is already fully merged into the default branch:
 * no diff against the base branch AND the branch's HEAD commit is reachable from it.
 * Returns a summary the operator can review before confirming reconciliation.
 *
 * Extracted from workspace-merge.service.ts (with reconcileAlreadyMerged) behind a thin
 * delegating facade to keep that module under the god-module ceiling (#103).
 */
export async function checkAlreadyMerged(
  id: string,
  deps: { database: Database; gitService: GitService },
): Promise<AlreadyMergedCheck> {
  const { database, gitService } = deps;
  const workspace = await getWorkspaceById(id, database);
  if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
  if (workspace.isDirect) throw new WorkspaceError("Not applicable to direct workspaces", "BAD_REQUEST");
  if (!workspace.branch) throw new WorkspaceError("Workspace has no branch", "BAD_REQUEST");

  const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
  const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

  // Resolve issue number for the confirmation summary
  const issueNumber = await getIssueNumberById(workspace.issueId, database);

  // Check working-dir exists for accurate diff
  let diffOutput = "";
  let diffFromWorktree = false;
  if (workspace.workingDir) {
    try {
      diffOutput = await gitService.getDiff(workspace.workingDir, baseBranch);
      diffFromWorktree = true;
    } catch {
      // worktree gone - fall through to repo-level diff
    }
  }
  if (!diffFromWorktree) {
    diffOutput = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
  }

  if (diffOutput.trim() !== "") {
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason: "Branch still has a diff against " + baseBranch,
    };
  }

  const ancestryResult = await gitService.checkBranchTipIsAncestor(repoPath, workspace.branch, baseBranch, workspace.workingDir ?? undefined);
  if (ancestryResult.branchSha === null) {
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason: ancestryResult.reason === "base-not-found"
        ? "Could not resolve base branch " + baseBranch
        : "Branch ref not found and no worktree available",
    };
  }
  const branchSha = ancestryResult.branchSha;
  const baseSha = ancestryResult.baseSha;
  if (!ancestryResult.isAncestor) {
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason: "Branch commit is not reachable from " + baseBranch,
    };
  }

  let uniqueCommits = 0;
  try {
    uniqueCommits = await gitService.countUniqueCommits(repoPath, baseSha, branchSha);
  } catch {
    uniqueCommits = 0;
  }
  const originalUniqueCommits = uniqueCommits === 0 && branchSha !== baseSha && workspace.baseCommitSha
    ? await gitService.countUniqueCommits(repoPath, workspace.baseCommitSha, branchSha).catch(() => 0)
    : 0;
  const leadingHasUnique = uniqueCommits > 0 || originalUniqueCommits > 0;

  // Multi-repo: "fully merged" must hold for EVERY repo of the workspace, not just the
  // leading one. This sibling check MUST run BEFORE the leading no-unique-commits early
  // return (#69): a sibling-only ticket's leading branch has 0 unique commits, so
  // returning here first both reports a misleading "no unique commits" reason AND — once
  // the sibling work has actually landed — wrongly refuses to reconcile the workspace as
  // Done, stranding it open forever with its issue never reaching Done.
  const pendingSiblings = await listPendingSiblingMerges(gitService, database, id);
  if (pendingSiblings.length > 0) {
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason: "Sibling repo(s) still have unmerged commits: " +
        pendingSiblings.map((p) => `${p.repo.name ?? p.repo.path} (${p.uniqueCommits})`).join(", "),
    };
  }

  if (!leadingHasUnique) {
    // Leading repo contributed nothing and no sibling is pending. This is "already
    // merged" ONLY if a sibling actually DID contribute work that has since landed
    // (mergedHeadSha stamped by the sibling merge pipeline) — otherwise the whole
    // workspace is genuinely empty (nothing was ever committed anywhere).
    const anySiblingLanded = (await listWorkspaceRepos(id, database)).some((r) => r.mergedHeadSha);
    if (!anySiblingLanded) {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: "Branch has no unique commits relative to " + baseBranch,
      };
    }
  }

  // Find the merge commit: the commit on baseBranch that first introduced this SHA
  let mergeCommitSha: string | null = null;
  try {
    mergeCommitSha = (await gitService.revParse(repoPath, baseBranch)).trim() || null;
  } catch { /* non-fatal */ }

  return {
    isAlreadyMerged: true,
    branch: workspace.branch,
    baseBranch,
    mergeCommitSha,
    issueNumber,
  };
}

/**
 * Reconcile an already-merged workspace as Done without running git merge:
 * close the workspace and move the issue to Done.
 */
export async function reconcileAlreadyMerged(
  id: string,
  deps: {
    database: Database;
    gitService: GitService;
    boardEvents?: BoardEvents;
    recordMergeAttempt: (
      workspace: typeof workspaces.$inferSelect,
      eventType: "already-merged",
      body: string,
      payload?: Record<string, unknown>,
      createdAt?: string,
    ) => Promise<void>;
  },
) {
  const { database, gitService, boardEvents, recordMergeAttempt } = deps;
  const workspace = await getWorkspaceById(id, database);
  if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
  if (workspace.status === "closed") throw new WorkspaceError("Workspace is already closed", "BAD_REQUEST");

  const check = await checkAlreadyMerged(id, { database, gitService });
  if (!check.isAlreadyMerged) {
    throw new WorkspaceError(
      check.reason ?? "Branch is not fully merged into " + check.baseBranch,
      "BAD_REQUEST",
      { reason: check.reason },
    );
  }

  const { repoPath } = await resolveProjectRepo(id, database);
  const now = new Date().toISOString();

  await finalizeMergeCleanup({
    database,
    boardEvents,
    workspaceId: id,
    issueId: workspace.issueId,
    now,
    closedAt: workspace.closedAt ?? now,
    mergedAt: workspace.mergedAt ?? now,
    workingDir: null,
  });

  // Best-effort worktree cleanup
  if (workspace.workingDir && !workspace.isDirect) {
    // Tear the per-workspace service stack down BEFORE the worktree is removed, like
    // every other end path — reconcile-already-merged previously leaked it (#F4). Uses
    // the STORED compose project name; gated on a persisted serviceState.
    const reconcileComposeName = parseStoredComposeProjectName(workspace.serviceState);
    if (reconcileComposeName) {
      await workspaceServicesService.teardownWorkspaceServices({
        composeProjectName: reconcileComposeName,
        composeWorktreePath: workspace.workingDir,
        releasedByWorkspaceId: id,
      });
    }
    try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* non-fatal */ }
  }

  // Multi-repo: drop the sibling worktrees + branches too (no-op single-repo) —
  // without this they orphan forever (the workspace's workingDir is nulled above, so
  // pruneStaleWorktrees never revisits it). checkAlreadyMerged already refused when a
  // sibling still had unmerged commits, and preserveUnmerged re-verifies per repo
  // before deleting anything.
  await cleanupSiblingWorktrees(gitService, id, database, { preserveUnmerged: true });

  try {
    await recordMergeAttempt(
      workspace,
      "already-merged",
      `Reconciled as Done: branch ${workspace.branch} was already merged into ${check.baseBranch} (commit ${check.mergeCommitSha ?? "unknown"}).`,
      { baseBranch: check.baseBranch, mergeCommitSha: check.mergeCommitSha, reconciledAt: now },
      now,
    );
  } catch { /* non-fatal */ }

  return {
    id,
    branch: check.branch,
    baseBranch: check.baseBranch,
    mergeCommitSha: check.mergeCommitSha,
    issueNumber: check.issueNumber,
    reconciledAt: now,
  };
}
