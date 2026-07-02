import {
  workspaces,
  issues,
  projects,
  sessions,
  projectStatuses,
  agentSkills,
} from "@agentic-kanban/shared/schema";
import { desc, eq, ne, inArray, and, gte, isNotNull } from "drizzle-orm";
import { deleteWorkspaceCascade as deleteWorkspaceCascadeShared } from "@agentic-kanban/shared/lib/cascade-delete";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { setWorkspaceStatus, type WorkspaceStatus } from "./workspace-status.repository.js";
import { getProjectById } from "./project.repository.js";

type WorkflowDbLike = Parameters<typeof transitionIssueStatus>[0];

type Project = typeof projects.$inferSelect;
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { mapWorkspaceDetailsRow } from "../lib/workspace-details-projection.js";

type Workspace = typeof workspaces.$inferSelect;

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
): Promise<Workspace | null> {
  const rows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
}

/** All workspaces (full rows) for an issue (CLI `issue status` / `issue summary`). */
export async function getWorkspacesByIssueId(issueId: string, database: Database = db): Promise<Workspace[]> {
  return database.select().from(workspaces).where(eq(workspaces.issueId, issueId));
}

// ───────────────────────── Workspace analytics reads ─────────────────────────
// Pure aggregation-source reads for the dashboard routes; the route owns the
// date-axis / bucketing / rollup computation over the returned rows.

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

/**
 * Slim workspace list (id/status/readyForMerge/issueId/branch/provider/model/
 * mergedAt/isDirect/timestamps), scoped EITHER by issueId (no join) or by
 * projectId (join through issues). Optional status filter + limit/offset.
 * issueId takes precedence when both are passed (mirrors the route's branching).
 */
export async function listWorkspacesSlim(
  opts: { issueId?: string; projectId?: string; statusFilter?: string[] | null; limit?: number; offset?: number },
  database: Database = db,
) {
  const selectShape = {
    id: workspaces.id,
    issueId: workspaces.issueId,
    branch: workspaces.branch,
    status: workspaces.status,
    readyForMerge: workspaces.readyForMerge,
    provider: workspaces.provider,
    model: workspaces.model,
    mergedAt: workspaces.mergedAt,
    isDirect: workspaces.isDirect,
    createdAt: workspaces.createdAt,
    updatedAt: workspaces.updatedAt,
  };
  const { issueId, projectId, statusFilter, limit, offset } = opts;

  if (issueId) {
    const conditions = [eq(workspaces.issueId, issueId)];
    if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
    let query = database.select(selectShape).from(workspaces).where(and(...conditions)).$dynamic();
    if (limit !== undefined) query = query.limit(limit);
    if (offset !== undefined) query = query.offset(offset);
    return query;
  }

  const conditions = [eq(issues.projectId, projectId!)];
  if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
  let query = database
    .select(selectShape)
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(...conditions))
    .$dynamic();
  if (limit !== undefined) query = query.limit(limit);
  if (offset !== undefined) query = query.offset(offset);
  return query;
}

/**
 * Lightweight workspace rows for a set of issues — id/issueId/branch/status/closedAt.
 * Used by the standup digest to find merged (closed-in-window) workspaces and to
 * map workspace ids back to issues for the session rollup.
 */
export async function getWorkspacesForIssues(issueIds: string[], database: Database = db) {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      closedAt: workspaces.closedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

export async function updateWorkspaceStatus(
  workspaceId: string,
  status: string,
  extra: Partial<Omit<Workspace, "id" | "status" | "updatedAt">> = {},
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, { set: extra });
}

export async function resolveProjectFull(
  workspaceId: string,
  database: Database = db,
): Promise<{ project: Project | null; repoPath: string; defaultBranch: string | null }> {
  const wsRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) throw new Error("Workspace not found");

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) throw new Error("Issue not found");

  const project = await getProjectById(issueRows[0].projectId, database);
  if (!project) throw new Error("Project not found");

  return { project, repoPath: project.repoPath, defaultBranch: project.defaultBranch };
}

export async function resolveProjectRepo(
  workspaceId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string | null }> {
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) throw new Error("Workspace not found");

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) throw new Error("Issue not found");

  const project = await getProjectById(issueRows[0].projectId, database);
  if (!project) throw new Error("Project not found");

  return { repoPath: project.repoPath, defaultBranch: project.defaultBranch };
}

export async function resolveProjectId(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const wsRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) return null;

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) return null;

  return issueRows[0].projectId;
}

/**
 * Move the issue associated with a workspace to "Done" (or "AI Reviewed" as fallback).
 * Logs a warning on failure but never throws.
 */
export async function moveIssueToDone(
  workspaceId: string,
  issueId: string,
  now: string,
  database: Database = db,
  fallbackToAiReviewed = false,
): Promise<void> {
  try {
    const projectId = await resolveProjectId(workspaceId, database);
    if (!projectId) return;
    const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const doneStatus = statuses.find(s => s.name === "Done")
      ?? (fallbackToAiReviewed ? statuses.find(s => s.name === "AI Reviewed") : undefined);
    if (doneStatus) {
      await transitionIssueStatus(database, issueId, doneStatus.id, { now });
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to Done:", err);
  }
}

/**
 * Move the issue to "In Progress" when a workspace is created.
 * Logs a warning on failure but never throws.
 */
export async function moveIssueToInProgress(
  issueId: string,
  projectId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  try {
    const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const inProgress = statuses.find(s => s.name === "In Progress");
    if (inProgress) {
      await transitionIssueStatus(database, issueId, inProgress.id, { now });
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to In Progress:", err);
  }
}

/**
 * Transaction-safe variant for workspace creation. Unlike moveIssueToInProgress,
 * this throws so callers inside a transaction can roll back the workspace insert.
 */
export async function moveIssueToInProgressStrict(
  issueId: string,
  projectId: string,
  now: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
  const inProgress = statuses.find(s => s.name === "In Progress");
  if (!inProgress) {
    throw new Error(`Project ${projectId} has no In Progress status`);
  }
  // A TransactionClient is structurally a WorkflowDb for the select/update calls
  // transitionIssueStatus makes; the node sync participates in the caller's tx.
  await transitionIssueStatus(database as WorkflowDbLike, issueId, inProgress.id, { now });
}

/** Cascade delete a workspace and every table that directly FK-references it. */
/**
 * AK-535 terminal-move guard: the open, non-direct, unmerged workspace for an
 * issue (or null). Open = status != "closed" (a merged workspace is closed);
 * direct workspaces (isDirect=true) commit straight to the default branch — no
 * branch to strand — so they are excluded. Moving an issue to a terminal status
 * while such a workspace exists strands the branch (silent merge loss). The
 * server-side mirror of mcp-server db-utils.checkOpenUnmergedWorkspace, so the
 * status-write transports (MCP move/update, server PATCH, CLI move) share one guard.
 */
export async function findOpenUnmergedWorkspace(
  issueId: string,
  database: Database = db,
): Promise<{ id: string; branch: string } | null> {
  const rows = await database
    .select({ id: workspaces.id, branch: workspaces.branch })
    .from(workspaces)
    .where(and(
      eq(workspaces.issueId, issueId),
      ne(workspaces.status, "closed"),
      eq(workspaces.isDirect, false),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteWorkspaceCascade(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await deleteWorkspaceCascadeShared(workspaceId, database);
}

// WorkspaceDetails + its pure row->DTO projection live in lib/workspace-details-projection.
// Re-exported here so existing importers keep their `from "../repositories/..."` path.
import type { WorkspaceDetails } from "../lib/workspace-details-projection.js";
export type { WorkspaceDetails };

export async function getWorkspaceDetails(
  workspaceId: string,
  database: Database = db,
): Promise<WorkspaceDetails | null> {
  const result = await database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      planMode: workspaces.planMode,
      includeVisualProof: workspaces.includeVisualProof,
      requiresReview: workspaces.requiresReview,
      thoroughReview: workspaces.thoroughReview,
      readyForMerge: workspaces.readyForMerge,
      status: workspaces.status,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      skillId: workspaces.skillId,
      contextPrimer: workspaces.contextPrimer,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      scorecardScore: workspaces.scorecardScore,
      latestSetupCommand: workspaces.latestSetupCommand,
      latestSetupState: workspaces.latestSetupState,
      latestSetupStartedAt: workspaces.latestSetupStartedAt,
      latestSetupEndedAt: workspaces.latestSetupEndedAt,
      latestSetupExitCode: workspaces.latestSetupExitCode,
      latestSetupDurationMs: workspaces.latestSetupDurationMs,
      latestSetupStdoutTail: workspaces.latestSetupStdoutTail,
      latestSetupStderrTail: workspaces.latestSetupStderrTail,
      latestSymlinkState: workspaces.latestSymlinkState,
      latestSymlinkStartedAt: workspaces.latestSymlinkStartedAt,
      latestSymlinkEndedAt: workspaces.latestSymlinkEndedAt,
      latestSymlinkDirs: workspaces.latestSymlinkDirs,
      latestSymlinkLinked: workspaces.latestSymlinkLinked,
      latestSymlinkSkipped: workspaces.latestSymlinkSkipped,
      latestSymlinkFailed: workspaces.latestSymlinkFailed,
      latestSymlinkError: workspaces.latestSymlinkError,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      issueTitle: issues.title,
      issuePriority: issues.priority,
      skillName: agentSkills.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
    .where(eq(workspaces.id, workspaceId));

  if (result.length === 0) return null;

  const row = result[0];

  const sessRows = await database
    .select({
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      triggerType: sessions.triggerType,
      stats: sessions.stats,
    })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  const sess = sessRows[0] ?? null;

  return mapWorkspaceDetailsRow(row, sess);
}

/** The most-recently-updated workspace for an issue (or null). */
export async function getLatestWorkspaceForIssue(
  issueId: string,
  database: Database = db,
): Promise<Workspace | null> {
  const rows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId))
    .orderBy(desc(workspaces.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Count of globally-active workspaces (status = "active"), across all projects. */
export async function getActiveWorkspaceCount(database: Database = db): Promise<number> {
  const rows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.status, "active"));
  return rows.length;
}

/** All workspaces in the "closed" state (across projects). */
export async function getClosedWorkspaces(database: Database = db) {
  return database.select().from(workspaces).where(eq(workspaces.status, "closed"));
}

/** {issueId, projectId, issueNumber} for a workspace (joined to its issue), or null. */
export async function getWorkspaceIssueContext(workspaceId: string, database: Database = db) {
  const rows = await database
    .select({ issueId: workspaces.issueId, projectId: issues.projectId, issueNumber: issues.issueNumber })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}
