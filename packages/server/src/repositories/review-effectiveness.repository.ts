import { eq, inArray, gte, lte, and } from "drizzle-orm";
import { issues, workspaces, sessions, diffComments, issueDependencies } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface ReviewEffectivenessSessionRow {
  sessionId: string;
  triggerType: string | null;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  sessionStatus: string;
  stats: string | null;
  workspaceId: string;
  branch: string;
  wsStatus: string;
  provider: string | null;
  mergedAt: string | null;
  readyForMerge: boolean;
  requiresReview: boolean;
  thoroughReview: boolean;
  scorecardScore: number | null;
  issueNumber: number | null;
  issueTitle: string;
  issueType: string;
}

/**
 * Session rows joined to their workspace + issue for the review-effectiveness
 * lifecycle analysis, filtered by project, the started-at window, and an
 * optional explicit issue-id set.
 */
export async function getReviewEffectivenessSessionRows(
  filter: {
    projectId: string;
    sinceIso: string;
    untilIso?: string | null;
    issueIds?: string[] | null;
  },
  database: Database = db,
): Promise<ReviewEffectivenessSessionRow[]> {
  const conditions = [eq(issues.projectId, filter.projectId), gte(sessions.startedAt, filter.sinceIso)];
  if (filter.untilIso) conditions.push(lte(sessions.startedAt, filter.untilIso));
  if (filter.issueIds) {
    // Empty scope means "no issues in this drive" — short-circuit to an impossible
    // filter so we don't accidentally fall through to the whole project.
    if (filter.issueIds.length === 0) conditions.push(eq(issues.id, "\0__none__"));
    else conditions.push(inArray(issues.id, filter.issueIds));
  }

  return database
    .select({
      sessionId: sessions.id,
      triggerType: sessions.triggerType,
      executor: sessions.executor,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      sessionStatus: sessions.status,
      stats: sessions.stats,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      wsStatus: workspaces.status,
      provider: workspaces.provider,
      mergedAt: workspaces.mergedAt,
      readyForMerge: workspaces.readyForMerge,
      requiresReview: workspaces.requiresReview,
      thoroughReview: workspaces.thoroughReview,
      scorecardScore: workspaces.scorecardScore,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueType: issues.issueType,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(...conditions))
    .orderBy(sessions.startedAt);
}

/** Diff comments (workspace id + resolvedAt) for a set of workspace ids. */
export async function getDiffCommentRowsForWorkspaces(
  workspaceIds: string[],
  database: Database = db,
): Promise<{ workspaceId: string; resolvedAt: string | null }[]> {
  if (workspaceIds.length === 0) return [];
  return database
    .select({ workspaceId: diffComments.workspaceId, resolvedAt: diffComments.resolvedAt })
    .from(diffComments)
    .where(inArray(diffComments.workspaceId, workspaceIds));
}

/** All issue ids belonging to a project. */
export async function getProjectIssueIds(
  projectId: string,
  database: Database = db,
): Promise<{ id: string }[]> {
  return database
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

/** Every dependency edge (issueId -> dependsOnId) in the DB. */
export async function getAllDependencyEdges(
  database: Database = db,
): Promise<{ issueId: string; dependsOnId: string }[]> {
  return database
    .select({ issueId: issueDependencies.issueId, dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies);
}
