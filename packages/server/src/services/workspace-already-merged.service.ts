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
import { cleanupSiblingWorktrees, stampReconciledMerges } from "./workspace-repos.service.js";
import { finalizeMergeCleanup } from "./merge-cleanup.service.js";
import {
  WorkspaceError,
  requireBaseBranch,
  listPendingSiblingMerges,
  listDirtySiblingWorktrees,
  type GitService,
} from "./workspace-internals.js";

export type AlreadyMergedCheck = {
  isAlreadyMerged: boolean;
  branch: string;
  baseBranch: string;
  mergeCommitSha: string | null;
  issueNumber: number | null;
  reason?: string;
  /**
   * True when `isAlreadyMerged` was granted only because the caller passed
   * `adoptMainCheckout` to override the "no unique commits" refusal — the work is
   * asserted (not git-verified) to have landed on the base branch out-of-band (#218).
   */
  adopted?: boolean;
};

/**
 * Check whether a workspace's branch is already fully merged into the default branch:
 * no diff against the base branch AND the branch's HEAD commit is reachable from it.
 * Returns a summary the operator can review before confirming reconciliation.
 *
 * Extracted from workspace-merge.service.ts (with reconcileAlreadyMerged) behind a thin
 * delegating facade to keep that module under the god-module ceiling (#103).
 *
 * `adoptMainCheckout` (#218): the ticket's own report showed a case where an agent
 * committed its work directly to the base branch out-of-band instead of the feature
 * branch (round-6 work landed straight on pantry's master). The branch genuinely has 0
 * unique commits relative to base — the leading-branch checks above already proved
 * there's no diff and the tip is a clean ancestor, so this is NOT the "nothing was ever
 * committed anywhere" case the refusal below exists to catch, it's just unprovable from
 * branch history alone. There is no git signal that distinguishes "empty ticket" from
 * "work landed on base directly", so this is an explicit, operator-asserted override —
 * it must never be inferred automatically, and it does NOT bypass any of the earlier
 * diff/ancestry/pending-sibling/dirty-sibling refusals (those represent real unmerged or
 * uncommitted state and stay hard blocks).
 */
export async function checkAlreadyMerged(
  id: string,
  deps: { database: Database; gitService: GitService; adoptMainCheckout?: boolean },
): Promise<AlreadyMergedCheck> {
  const { database, gitService, adoptMainCheckout } = deps;
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
    const unverifiable = pendingSiblings.filter((p) => p.unverifiable);
    const reason = unverifiable.length > 0
      ? "Sibling repo pendency could not be verified — refusing to reconcile as merged: " +
        unverifiable.map((p) => p.unverifiableReason ?? `${p.repo.name ?? p.repo.path} at ${p.repo.path}`).join("; ") +
        (pendingSiblings.length > unverifiable.length
          ? `; also unmerged: ${pendingSiblings.filter((p) => !p.unverifiable).map((p) => `${p.repo.name ?? p.repo.path} (${p.uniqueCommits})`).join(", ")}`
          : "")
      : "Sibling repo(s) still have unmerged commits: " +
        pendingSiblings.map((p) => `${p.repo.name ?? p.repo.path} (${p.uniqueCommits})`).join(", ");
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason,
    };
  }

  // Sibling worktrees may hold UNCOMMITTED edits an agent never got around to
  // committing — invisible to the pending-commit check above (#153). Reconciling
  // as merged here would let `cleanupSiblingWorktrees`'s `git worktree remove
  // --force` silently destroy that work. Refuse until it's committed or discarded.
  const dirtySiblings = await listDirtySiblingWorktrees(gitService, database, id);
  if (dirtySiblings.length > 0) {
    return {
      isAlreadyMerged: false,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha: null,
      issueNumber,
      reason: "Sibling worktree(s) have uncommitted changes — refusing to reconcile as merged: " +
        dirtySiblings.map((d) => `${d.repo.name ?? d.repo.path}${d.detail ? ` (unverifiable: ${d.detail})` : ""}`).join(", "),
    };
  }

  let adopted = false;
  if (!leadingHasUnique) {
    // Leading repo contributed nothing and no sibling is pending. This is "already
    // merged" ONLY if a sibling actually DID contribute work that has since landed
    // (mergedHeadSha stamped by the sibling merge pipeline) — otherwise the whole
    // workspace is genuinely empty (nothing was ever committed anywhere), UNLESS the
    // operator explicitly asserts (`adoptMainCheckout`) that the work landed directly
    // on the base branch out-of-band (#218) — see the function doc above.
    const anySiblingLanded = (await listWorkspaceRepos(id, database)).some((r) => r.mergedHeadSha);
    if (!anySiblingLanded) {
      if (!adoptMainCheckout) {
        return {
          isAlreadyMerged: false,
          branch: workspace.branch,
          baseBranch,
          mergeCommitSha: null,
          issueNumber,
          reason: `Branch has no unique commits relative to ${baseBranch}. If this work legitimately ` +
            `landed directly on ${baseBranch} out-of-band, retry with adoptMainCheckout=true to close ` +
            `it as Done without a git merge.`,
        };
      }
      adopted = true;
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
    ...(adopted ? { adopted: true } : {}),
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
    /** Operator-asserted recovery override — see `checkAlreadyMerged`'s doc (#218). */
    adoptMainCheckout?: boolean;
    recordMergeAttempt: (
      workspace: typeof workspaces.$inferSelect,
      eventType: "already-merged",
      body: string,
      payload?: Record<string, unknown>,
      createdAt?: string,
    ) => Promise<void>;
  },
) {
  const { database, gitService, boardEvents, adoptMainCheckout, recordMergeAttempt } = deps;
  const workspace = await getWorkspaceById(id, database);
  if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
  if (workspace.status === "closed") throw new WorkspaceError("Workspace is already closed", "BAD_REQUEST");

  const check = await checkAlreadyMerged(id, { database, gitService, adoptMainCheckout });
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

  // Multi-repo (#114/#115, unified in #168): the reconciler agent hand-merged BOTH the leading
  // branch and each sibling's work into their mains, so nothing stamped `mergedHeadSha`
  // (unlike the executeSiblingMerges pipeline) and closeWorkspace stamped only `mergedAt`.
  // Record that positive evidence NOW — before the cleanup below force-deletes the branches —
  // in ONE pass over all repos, so getRepoMergeStatus (#75) reports every fully-landed repo as
  // merged instead of falsely reading it unmerged. No-op for already-stamped repos and for a
  // sibling-only ticket's empty leading branch (0 historic commits).
  try {
    const stamped = await stampReconciledMerges({ gitService, database, workspaceId: id, now });
    if (stamped.siblings > 0 || stamped.leading) {
      console.log(`[workspace-merge] reconcile-as-done: stamped ${stamped.leading ? "leading + " : ""}${stamped.siblings} landed sibling repo(s) for workspace ${id}`);
    }
  } catch (err) {
    console.warn(`[workspace-merge] reconcile-as-done: reconcile stamp failed (non-fatal) for workspace ${id}:`, err instanceof Error ? err.message : String(err));
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
      check.adopted
        ? `Reconciled as Done: branch ${workspace.branch} had no unique commits, but was adopted as already ` +
          `landed on ${check.baseBranch} out-of-band per operator confirmation (commit ${check.mergeCommitSha ?? "unknown"}).`
        : `Reconciled as Done: branch ${workspace.branch} was already merged into ${check.baseBranch} (commit ${check.mergeCommitSha ?? "unknown"}).`,
      { baseBranch: check.baseBranch, mergeCommitSha: check.mergeCommitSha, reconciledAt: now, adopted: check.adopted ?? false },
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
    adopted: check.adopted ?? false,
  };
}
