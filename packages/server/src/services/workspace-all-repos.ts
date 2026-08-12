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
  /**
   * #415 — the physical repos-row id backing this ref, the write target for the per-repo
   * merge-status projection (`summary_*` columns, migration 0118). Null only for a
   * leading ref whose row has not been backfilled yet (pre-0110) — such a ref is never
   * projection-fresh and never written through.
   */
  projectionRowId: string | null;
  /** #415 projection facts (see schema/repos.ts). Null = never projected. */
  summaryAhead: number | null;
  summaryHistoric: number | null;
  summaryGitRefreshedAt: string | null;
  /** Null when no backing row exists (never fresh). */
  summaryDirty: boolean | null;
}

/**
 * Project the leading repo's state into a uniform ref.
 *
 * #226 (stage 4): the physical `is_leading` row is the SOURCE; the workspace mirror columns
 * are a per-field fallback. This is the flip stage 2 deferred, and it is what moves every
 * `getAllWorkspaceRepos` consumer — the merge path, the reconcilers, rebase, merge-status —
 * onto the row in ONE change instead of repointing ~109 direct column reads individually.
 *
 * Two things had to be true first, and neither was:
 *  1. the repair had to stop converging row -> columns (it made the row unable to disagree,
 *     so the flip would have been a no-op by construction); and
 *  2. the dual-writes had to be complete. Four close paths were clearing `workingDir` through
 *     `setWorkspaceStatus(..., { set })`, which cannot mirror — after the flip those would
 *     have reported a worktree that had already been torn down. That hatch is now closed at
 *     the TYPE level (`SetWorkspaceStatusOpts`), so the gap cannot reopen silently.
 *
 * The fallback is not a hedge against the row: it is what POPULATES it. A workspace predating
 * migration 0110, or created in the stage-1->2 window, has no row until the repair below
 * inserts one from the columns — on this very read, before the row is consulted.
 */
async function leadingRef(workspaceId: string, database: Database): Promise<WorkspaceRepoRef | null> {
  const workspace = await getWorkspaceById(workspaceId, database);
  if (!workspace) return null;
  const { repoPath, defaultBranch } = await resolveProjectRepo(workspaceId, database);
  // #415 — the row is fetched ONCE and the read-repair (INSERT path) only runs when it is
  // missing. Every GET used to pay a second identical SELECT inside repairLeadingRepoRow
  // even though the row exists for every post-0110 workspace; on the batched cross-repo
  // panels that duplicate multiplied by N workspaces per burst.
  let row = await getLeadingRepoRow(workspaceId, database).catch(() => null);
  if (!row) {
    // AWAITED, not fire-and-forget: `database` is frequently a TRANSACTION client, and an
    // un-awaited statement still pending on a tx handle deadlocks its commit.
    try {
      await repairLeadingRepoRow(workspaceId, workspace, repoPath, defaultBranch, database);
      row = await getLeadingRepoRow(workspaceId, database).catch(() => null);
    } catch (err) {
      console.warn(`[workspace-all-repos] leading-row read-repair failed for ${workspaceId} (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  } else {
    // #226 — the row is the SOURCE, so divergence is REPORTED, not overwritten. Zero extra
    // queries: the comparison runs on the row/workspace already in hand.
    warnOnLeadingRowDivergence(workspaceId, workspace, defaultBranch, row);
  }
  return {
    kind: "leading",
    id: workspaceId,
    workspaceId,
    // `path`/`defaultBranch` stay PROJECT-derived. They describe the project's repo, not the
    // workspace's git state, and are not among the columns this stage drops.
    path: repoPath,
    name: null,
    worktreePath: row?.worktreePath ?? workspace.workingDir ?? null,
    branch: row?.branch ?? workspace.branch ?? null,
    // The leading repo's base is its own baseBranch, falling back to the project's default
    // branch (what it was cut from) — mirrors requireBaseBranch(baseBranch||defaultBranch)
    // in the merge-status/rebase paths (|| so an empty string also falls back), so a uniform
    // loop reads the same base a hand-written leading block did.
    baseBranch: row?.baseBranch || workspace.baseBranch || defaultBranch,
    baseCommitSha: row?.baseCommitSha ?? workspace.baseCommitSha ?? null,
    mergedHeadSha: row?.mergedHeadSha ?? workspace.mergedHeadSha ?? null,
    defaultBranch,
    projectionRowId: row?.id ?? null,
    summaryAhead: row?.summaryAhead ?? null,
    summaryHistoric: row?.summaryHistoric ?? null,
    summaryGitRefreshedAt: row?.summaryGitRefreshedAt ?? null,
    summaryDirty: row?.summaryDirty ?? null,
  };
}

/**
 * Backfill the physical leading row from the workspace mirror columns (#222 stage 2).
 * Only called when `leadingRef` found NO row (#415) — a workspace created in the
 * stage-1→2 window, or pre-migration-0110 — so the common post-0110 read never pays it.
 */
async function repairLeadingRepoRow(
  workspaceId: string,
  workspace: { workingDir: string | null; branch: string | null; baseBranch: string | null; baseCommitSha: string | null; mergedHeadSha: string | null },
  repoPath: string,
  defaultBranch: string | null,
  database: Database,
): Promise<void> {
  await insertLeadingWorkspaceRepo({
    workspaceId,
    path: repoPath,
    defaultBranch,
    worktreePath: workspace.workingDir ?? null,
    branch: workspace.branch ?? null,
    baseBranch: workspace.baseBranch || defaultBranch,
    baseCommitSha: workspace.baseCommitSha ?? null,
  }, database);
  if (workspace.mergedHeadSha) {
    await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { mergedHeadSha: workspace.mergedHeadSha }, database);
  }
}

/**
 * #226 — the row is now the SOURCE, so divergence is REPORTED, not overwritten. Converging
 * row -> columns (the stage-2 behaviour) would make the row unable to disagree, which is
 * exactly what made the source flip a no-op by construction. A warning here means a write
 * path updated a column without mirroring; with the `setWorkspaceStatus` hatch closed at the
 * type level that should be unreachable, so it is worth seeing rather than silently undoing.
 */
function warnOnLeadingRowDivergence(
  workspaceId: string,
  workspace: { workingDir: string | null; branch: string | null; baseBranch: string | null; baseCommitSha: string | null; mergedHeadSha: string | null },
  defaultBranch: string | null,
  row: RepoRow,
): void {
  const diverged =
    row.worktreePath !== (workspace.workingDir ?? null) ||
    row.branch !== (workspace.branch ?? null) ||
    row.baseBranch !== (workspace.baseBranch || defaultBranch) ||
    row.baseCommitSha !== (workspace.baseCommitSha ?? null) ||
    row.mergedHeadSha !== (workspace.mergedHeadSha ?? null);
  if (diverged) {
    console.warn(
      `[workspace-all-repos] leading row for ${workspaceId} diverged from the workspace mirror columns — ` +
      `the ROW wins (#226). A write path is updating a column without mirroring; find it rather than ignoring this.`,
    );
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
    projectionRowId: row.id,
    summaryAhead: row.summaryAhead,
    summaryHistoric: row.summaryHistoric,
    summaryGitRefreshedAt: row.summaryGitRefreshedAt,
    summaryDirty: row.summaryDirty,
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
