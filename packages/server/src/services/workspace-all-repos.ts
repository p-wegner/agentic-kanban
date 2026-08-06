/**
 * Uniform "all repos" view over a workspace (#168 — model the leading repo as row 0).
 *
 * The leading repo has no `repos` row: its git state is spread across the `workspaces`
 * row (branch/workingDir/baseBranch/baseCommitSha/mergedHeadSha) plus the project's
 * `repoPath`/`defaultBranch`. Sibling repos each get a `repos` row. That asymmetry forced
 * every merge/reconcile/rebase/status routine to be written twice — a leading branch and a
 * sibling loop — which drifted and kept forgetting the sibling half.
 *
 * {@link getAllWorkspaceRepos} collapses the two into ONE ordered list: element 0 is the
 * leading repo synthesized as a {@link WorkspaceRepoRef}, followed by each sibling row.
 * Callers iterate the single list; {@link stampRepoMergedHeadSha} routes a write back to the
 * right storage (workspace row for leading, `repos` row for a sibling). This realizes the
 * ticket's "keep the workspaces columns as a compatibility view" as a READ model — no schema
 * migration, no dual-write window — while killing the duplicated logic where the bugs lived.
 */

import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  getLeadingRepoRow,
  insertLeadingWorkspaceRepo,
  listWorkspaceRepos,
  mirrorWorkspaceColumnsToLeadingRepo,
  setWorkspaceRepoMergedSha,
  type RepoRow,
} from "../repositories/repo.repository.js";
import { getWorkspaceById, resolveProjectRepo } from "../repositories/workspace.repository.js";
import { stampWorkspaceMergedHeadSha } from "../repositories/workspace-merge-execution.repository.js";

export type RepoKind = "leading" | "sibling";

/**
 * One repo a workspace spans, in a shape common to the leading repo and the siblings.
 * Field correspondence (the seam #168 removes):
 *   leading (workspaces/projects)  ->  sibling (repos)
 *   projects.repoPath              ->  path
 *   workspaces.workingDir          ->  worktreePath
 *   workspaces.branch              ->  branch
 *   workspaces.baseBranch          ->  baseBranch
 *   workspaces.baseCommitSha       ->  baseCommitSha
 *   workspaces.mergedHeadSha       ->  mergedHeadSha
 *   projects.defaultBranch         ->  defaultBranch
 */
export interface WorkspaceRepoRef {
  kind: RepoKind;
  /** `repos.id` for a sibling; the workspaceId for the leading pseudo-row (its write target). */
  id: string;
  workspaceId: string;
  /** Repo root: `projects.repoPath` (leading) or `repos.path` (sibling). */
  path: string;
  /** Display name; null for the leading repo — callers key "leading" off `kind`, not the name. */
  name: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
  defaultBranch: string | null;
}

/**
 * Project the leading repo's state (workspace row + project row) into a uniform ref.
 *
 * #222 stage 2: the synthesized projection stays AUTHORITATIVE (the workspace columns are
 * still the source of truth until stage 4's column drop), but a physical `is_leading` row
 * now exists (migration 0110 + dual-writes) and this function READ-REPAIRS it: a missing
 * row is backfilled, a diverging one is converged to the synthesis. Best-effort — repair
 * failures never break a read.
 */
async function leadingRef(workspaceId: string, database: Database): Promise<WorkspaceRepoRef | null> {
  const workspace = await getWorkspaceById(workspaceId, database);
  if (!workspace) return null;
  const { repoPath, defaultBranch } = await resolveProjectRepo(workspaceId, database);
  // AWAITED, not fire-and-forget: `database` is frequently a TRANSACTION client, and an
  // un-awaited statement still pending on a tx handle deadlocks its commit.
  try {
    await repairLeadingRepoRow(workspaceId, workspace, repoPath, defaultBranch, database);
  } catch (err) {
    console.warn(`[workspace-all-repos] leading-row read-repair failed for ${workspaceId} (non-fatal):`, err instanceof Error ? err.message : String(err));
  }
  return {
    kind: "leading",
    id: workspaceId,
    workspaceId,
    path: repoPath,
    name: null,
    worktreePath: workspace.workingDir ?? null,
    branch: workspace.branch ?? null,
    // The leading repo's base is its workspace baseBranch, falling back to the project's
    // default branch (what it was cut from) — mirrors requireBaseBranch(baseBranch||defaultBranch)
    // in the merge-status/rebase paths (|| so an empty string also falls back), so a uniform
    // loop reads the same base a hand-written leading block did.
    baseBranch: workspace.baseBranch || defaultBranch,
    baseCommitSha: workspace.baseCommitSha ?? null,
    mergedHeadSha: workspace.mergedHeadSha ?? null,
    defaultBranch,
  };
}

/**
 * Converge the physical leading row to the synthesized truth (#222 stage 2). Fire-and-forget
 * from `leadingRef` — a workspace created in the stage-1→2 window (no row) gets one, and a
 * row a dual-write missed is brought back in line, so the rows are trustworthy by the time
 * stage 4 flips the source of truth.
 */
async function repairLeadingRepoRow(
  workspaceId: string,
  workspace: { workingDir: string | null; branch: string | null; baseBranch: string | null; baseCommitSha: string | null; mergedHeadSha: string | null },
  repoPath: string,
  defaultBranch: string | null,
  database: Database,
): Promise<void> {
  const truth = {
    workingDir: workspace.workingDir ?? null,
    branch: workspace.branch ?? null,
    baseBranch: workspace.baseBranch || defaultBranch,
    baseCommitSha: workspace.baseCommitSha ?? null,
    mergedHeadSha: workspace.mergedHeadSha ?? null,
  };
  const row = await getLeadingRepoRow(workspaceId, database);
  if (!row) {
    await insertLeadingWorkspaceRepo({
      workspaceId,
      path: repoPath,
      defaultBranch,
      worktreePath: truth.workingDir,
      branch: truth.branch,
      baseBranch: truth.baseBranch,
      baseCommitSha: truth.baseCommitSha,
    }, database);
    if (truth.mergedHeadSha) {
      await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { mergedHeadSha: truth.mergedHeadSha }, database);
    }
    return;
  }
  const diverged =
    row.worktreePath !== truth.workingDir ||
    row.branch !== truth.branch ||
    row.baseBranch !== truth.baseBranch ||
    row.baseCommitSha !== truth.baseCommitSha ||
    row.mergedHeadSha !== truth.mergedHeadSha;
  if (diverged) {
    console.warn(`[workspace-all-repos] leading row for ${workspaceId} diverged from workspace columns — converging (a dual-write path may be missing)`);
    await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, truth, database);
  }
}

/** Map a workspace-scoped `repos` row into a uniform ref. */
export function siblingRefFromRow(row: RepoRow): WorkspaceRepoRef {
  return {
    kind: "sibling",
    id: row.id,
    workspaceId: row.workspaceId as string,
    path: row.path,
    name: row.name,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommitSha: row.baseCommitSha,
    mergedHeadSha: row.mergedHeadSha,
    defaultBranch: row.defaultBranch,
  };
}

/**
 * Every repo the workspace spans, leading first (row 0) then siblings in `repos` order.
 * Empty only when the workspace itself is missing. A single-repo workspace returns exactly
 * one element (the leading ref) — the zero-regression fast path.
 */
export async function getAllWorkspaceRepos(workspaceId: string, database: Database = db): Promise<WorkspaceRepoRef[]> {
  const leading = await leadingRef(workspaceId, database);
  if (!leading) return [];
  const siblings = await listWorkspaceRepos(workspaceId, database);
  return [leading, ...siblings.map(siblingRefFromRow)];
}

/**
 * Record a repo's merged tip, routing the write to the correct storage:
 * leading -> the workspace row (`stampWorkspaceMergedHeadSha`, also bumps updatedAt),
 * sibling -> the `repos` row (`setWorkspaceRepoMergedSha`). `now` is used only by the
 * leading path (siblings carry no timestamp column).
 */
export async function stampRepoMergedHeadSha(
  ref: WorkspaceRepoRef,
  mergedHeadSha: string,
  now: string,
  database: Database = db,
): Promise<void> {
  if (ref.kind === "leading") {
    await stampWorkspaceMergedHeadSha(ref.workspaceId, mergedHeadSha, now, database);
  } else {
    await setWorkspaceRepoMergedSha(ref.id, mergedHeadSha, database);
  }
}
