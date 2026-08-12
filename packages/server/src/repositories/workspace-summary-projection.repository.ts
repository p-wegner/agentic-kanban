import { and, asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { issues, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * #399 (decision 014) — persistence for the workspace-summary git projection.
 * The projection lives on the `workspaces` row itself (`summary_*` columns, migration
 * 0114); this repository owns its three writes/reads: write-through after a git refresh,
 * dirty-marking from board events, and the heal pass's candidate selection.
 */

/** Same leading-repo aliasing as workspace-summary.repository (#222): the workspace's
 * effective workingDir/baseBranch come from its leading repos row, mirror columns as
 * fallback, and the alias keeps sibling rows from multiplying the result. */
const leadingRepo = alias(repos, "leading_repo");
const onLeadingRepo = and(eq(leadingRepo.workspaceId, workspaces.id), eq(leadingRepo.isLeading, true));

export interface SummaryGitProjectionValues {
  summaryHeadSha: string | null;
  summaryHeadMessage: string | null;
  summaryCommitCount: number | null;
  summaryGitRefreshedAt: string;
}

/** Write-through after a git refresh: store the facts, stamp freshness, clear dirty. */
export async function updateWorkspaceSummaryGitProjection(
  workspaceId: string,
  values: SummaryGitProjectionValues,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ ...values, summaryDirty: false })
    .where(eq(workspaces.id, workspaceId));
}

/** Board-event hook: mark one workspace's projection as needing a refresh.
 * #415: also dirties the workspace's per-repo merge-status projection (repos rows) —
 * every event that can move the workspace git facts (merge, rebase, status change)
 * can move the per-repo ahead/merged facts too. */
export async function markWorkspaceSummaryDirty(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ summaryDirty: true })
    .where(eq(workspaces.id, workspaceId));
  await markWorkspaceRepoSummariesDirty(workspaceId, database);
}

/** #415 — dirty-mark the per-repo merge-status projection of every repos row (leading +
 * siblings) a workspace spans. Board-event hook, same contract as the workspace flag. */
export async function markWorkspaceRepoSummariesDirty(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(repos)
    .set({ summaryDirty: true })
    .where(eq(repos.workspaceId, workspaceId));
}

export interface RepoSummaryProjectionValues {
  summaryAhead: number | null;
  summaryHistoric: number | null;
  summaryGitRefreshedAt: string;
}

/** #415 — write-through after a live per-repo merge-status computation: store the
 * ahead/historic facts on the repos row, stamp freshness, clear dirty. */
export async function updateRepoSummaryProjection(
  rowId: string,
  values: RepoSummaryProjectionValues,
  database: Database = db,
): Promise<void> {
  await database
    .update(repos)
    .set({ ...values, summaryDirty: false })
    .where(eq(repos.id, rowId));
}

export interface RepoSummaryHealCandidate {
  /** The repos-row id (write target). */
  rowId: string;
  workspaceId: string;
  workspaceStatus: string;
  isLeading: boolean;
  path: string;
  name: string | null;
  branch: string | null;
  /** Coalesced with the workspace/project fallbacks for leading rows (#226 precedence). */
  baseBranch: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
  worktreePath: string | null;
  summaryAhead: number | null;
  summaryHistoric: number | null;
  summaryGitRefreshedAt: string | null;
  summaryDirty: boolean;
}

/**
 * #415 — the heal pass's bounded worklist over repos rows: workspace-scoped rows of
 * non-closed workspaces whose per-repo projection is dirty or older than `staleBefore`,
 * dirtiest first. Rows with a stamped mergedHeadSha are excluded — their merge-status
 * entry short-circuits to `merged` without ever reading the projection.
 */
export async function selectRepoSummaryHealCandidates(
  limit: number,
  staleBefore: string,
  database: Database = db,
): Promise<RepoSummaryHealCandidate[]> {
  return database
    .select({
      rowId: repos.id,
      workspaceId: sql<string>`${workspaces.id}`,
      workspaceStatus: workspaces.status,
      isLeading: repos.isLeading,
      path: repos.path,
      name: repos.name,
      branch: sql<string | null>`coalesce(${repos.branch}, ${workspaces.branch})`,
      baseBranch: sql<string | null>`coalesce(${repos.baseBranch}, ${workspaces.baseBranch}, ${projects.defaultBranch})`,
      baseCommitSha: sql<string | null>`coalesce(${repos.baseCommitSha}, ${workspaces.baseCommitSha})`,
      mergedHeadSha: repos.mergedHeadSha,
      worktreePath: repos.worktreePath,
      summaryAhead: repos.summaryAhead,
      summaryHistoric: repos.summaryHistoric,
      summaryGitRefreshedAt: repos.summaryGitRefreshedAt,
      summaryDirty: repos.summaryDirty,
    })
    .from(repos)
    .innerJoin(workspaces, eq(workspaces.id, repos.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(
      ne(workspaces.status, "closed"),
      isNull(repos.mergedHeadSha),
      or(
        eq(repos.summaryDirty, true),
        isNull(repos.summaryGitRefreshedAt),
        lt(repos.summaryGitRefreshedAt, staleBefore),
      ),
    ))
    .orderBy(desc(repos.summaryDirty), asc(repos.summaryGitRefreshedAt))
    .limit(limit);
}

export interface SummaryHealCandidate {
  id: string;
  status: string;
  isDirect: boolean;
  workingDir: string | null;
  baseBranch: string | null;
  diffStatCacheHeadSha: string | null;
  summaryDirty: boolean;
  /** Previously projected facts (G13) — the refresh's change gate compares against these. */
  summaryHeadSha: string | null;
  summaryCommitCount: number | null;
  /** The owning project's default branch — the base fallback when `baseBranch` is null. */
  defaultBranch: string | null;
}

/**
 * The reconcile pass's bounded worklist: non-closed workspaces whose projection is dirty
 * or older than `staleBefore`, dirtiest first (dirty flag, then oldest stamp — SQLite
 * sorts NULL first under ASC, so never-refreshed rows lead their group).
 */
export async function selectSummaryHealCandidates(
  limit: number,
  staleBefore: string,
  database: Database = db,
): Promise<SummaryHealCandidate[]> {
  return database
    .select({
      id: workspaces.id,
      status: workspaces.status,
      isDirect: workspaces.isDirect,
      workingDir: sql<string | null>`coalesce(${leadingRepo.worktreePath}, ${workspaces.workingDir})`,
      baseBranch: sql<string | null>`coalesce(${leadingRepo.baseBranch}, ${workspaces.baseBranch})`,
      diffStatCacheHeadSha: workspaces.diffStatCacheHeadSha,
      summaryDirty: workspaces.summaryDirty,
      summaryHeadSha: workspaces.summaryHeadSha,
      summaryCommitCount: workspaces.summaryCommitCount,
      defaultBranch: projects.defaultBranch,
    })
    .from(workspaces)
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(leadingRepo, onLeadingRepo)
    .where(and(
      ne(workspaces.status, "closed"),
      or(
        eq(workspaces.summaryDirty, true),
        isNull(workspaces.summaryGitRefreshedAt),
        lt(workspaces.summaryGitRefreshedAt, staleBefore),
      ),
    ))
    .orderBy(desc(workspaces.summaryDirty), asc(workspaces.summaryGitRefreshedAt))
    .limit(limit);
}
