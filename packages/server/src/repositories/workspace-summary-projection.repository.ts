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

/** Board-event hook: mark one workspace's projection as needing a refresh. */
export async function markWorkspaceSummaryDirty(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ summaryDirty: true })
    .where(eq(workspaces.id, workspaceId));
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
