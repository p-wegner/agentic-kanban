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
import { listWorkspaceRepos, setWorkspaceRepoMergedSha, type RepoRow } from "../repositories/repo.repository.js";
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

/** Project the leading repo's state (workspace row + project row) into a uniform ref. */
async function leadingRef(workspaceId: string, database: Database): Promise<WorkspaceRepoRef | null> {
  const workspace = await getWorkspaceById(workspaceId, database);
  if (!workspace) return null;
  const { repoPath, defaultBranch } = await resolveProjectRepo(workspaceId, database);
  return {
    kind: "leading",
    id: workspaceId,
    workspaceId,
    path: repoPath,
    name: null,
    worktreePath: workspace.workingDir ?? null,
    branch: workspace.branch ?? null,
    baseBranch: workspace.baseBranch ?? null,
    baseCommitSha: workspace.baseCommitSha ?? null,
    mergedHeadSha: workspace.mergedHeadSha ?? null,
    defaultBranch,
  };
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
