// ───────────────────────── Workspace analytics reads ─────────────────────────
// Pure aggregation-source reads for the dashboard routes; the route owns the
// date-axis / bucketing / rollup computation over the returned rows.

import { workspaces, issues, sessions } from "@agentic-kanban/shared/schema";
import { eq, and, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Workspaces created since `cutoffDay` for a project, with provider attribution (provider-mix chart). */
export async function getProviderMixRows(projectId: string, cutoffDay: string, database: Database = db) {
  return database
    .select({
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), gte(workspaces.createdAt, cutoffDay)));
}

/**
 * How many of a project's workspaces have actually landed on the default branch.
 *
 * `mergedAt` — not issue status, not `status = 'closed'` — is the authoritative merge
 * marker (a closed workspace may have been abandoned, and a Done issue may have been
 * hand-merged). Workspaces carry no `projectId`, so the scope goes through `issues`.
 * Used by the compounding "setup once" pass (#127) to decide a project has accumulated
 * enough code to be worth setting up once.
 */
export async function countMergedWorkspacesForProject(
  projectId: string,
  database: Database = db,
): Promise<number> {
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), isNotNull(workspaces.mergedAt)));
  return rows.length;
}

/** Sessions started since `cutoffIso` for a project, with the workspace provider + stats blob (cost-over-time chart). */
export async function getCostOverTimeRows(projectId: string, cutoffIso: string, database: Database = db) {
  return database
    .select({
      provider: workspaces.provider,
      startedAt: sessions.startedAt,
      stats: sessions.stats,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), gte(sessions.startedAt, cutoffIso)));
}

/** Currently-active (active/fixing) workspaces for a project with provider attribution (Insights ledger). */
export async function getActiveWorkspacesForProject(projectId: string, database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), inArray(workspaces.status, ["active", "fixing"])));
}

/** Non-null scorecard scores for workspaces created since `cutoffDay` (scorecard histogram). */
export async function getScorecardScores(projectId: string, cutoffDay: string, database: Database = db) {
  return database
    .select({ score: workspaces.scorecardScore })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        gte(workspaces.createdAt, cutoffDay),
        isNotNull(workspaces.scorecardScore),
      ),
    );
}
