import { workspaces, sessions, sessionMessages, showdowns, workflowEdges, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function aggregateWorkspaceCountRows(issueIds: string[], database: Database = db) {
  return database
    .select({
      issueId: workspaces.issueId,
      status: workspaces.status,
      branch: workspaces.branch,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds))
    .groupBy(workspaces.issueId, workspaces.status, workspaces.branch);
}

export async function fetchWorkspaceDetailRows(issueIds: string[], database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      planMode: workspaces.planMode,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      conflictCacheCheckedAt: workspaces.conflictCacheCheckedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      readyForMerge: workspaces.readyForMerge,
      diffStatCacheCheckedAt: workspaces.diffStatCacheCheckedAt,
      diffStatCacheHeadSha: workspaces.diffStatCacheHeadSha,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      scorecardScore: workspaces.scorecardScore,
      codeMetricsJson: workspaces.codeMetricsJson,
      codeMetricsComputedAt: workspaces.codeMetricsComputedAt,
      currentNodeId: workspaces.currentNodeId,
      showdownId: workspaces.showdownId,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

export async function getShowdownStatuses(showdownIds: string[], database: Database = db) {
  return database
    .select({ id: showdowns.id, status: showdowns.status })
    .from(showdowns)
    .where(inArray(showdowns.id, showdownIds));
}

export async function updateWorkspaceDiffStatCache(
  workspaceId: string,
  values: {
    diffStatCacheCheckedAt: string;
    diffStatCacheHeadSha: string | null;
    diffStatCacheFilesChanged: number;
    diffStatCacheInsertions: number;
    diffStatCacheDeletions: number;
  },
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
}

export async function updateWorkspaceConflictCache(
  workspaceId: string,
  values: {
    conflictCacheCheckedAt: string;
    conflictCacheHasConflicts: boolean;
    conflictCacheFiles: string;
  },
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
}

export async function getWorkflowNodesByIds(nodeIds: string[], database: Database = db) {
  return database
    .select({
      id: workflowNodes.id,
      name: workflowNodes.name,
      nodeType: workflowNodes.nodeType,
      statusName: workflowNodes.statusName,
    })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, nodeIds));
}

export async function getOutgoingWorkflowEdges(fromNodeIds: string[], database: Database = db) {
  return database
    .select({
      fromNodeId: workflowEdges.fromNodeId,
      toNodeId: workflowEdges.toNodeId,
      sortOrder: workflowEdges.sortOrder,
    })
    .from(workflowEdges)
    .where(inArray(workflowEdges.fromNodeId, fromNodeIds));
}

export async function getWorkflowNodeNamesByIds(nodeIds: string[], database: Database = db) {
  return database
    .select({ id: workflowNodes.id, name: workflowNodes.name })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, nodeIds));
}

export async function getSessionsForWorkspaces(workspaceIds: string[], database: Database = db) {
  return database
    .select({
      id: sessions.id,
      workspaceId: sessions.workspaceId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      stats: sessions.stats,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(sessions.startedAt);
}

export async function getSessionMessagesForSessions(sessionIds: string[], database: Database = db) {
  return database
    .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
    .from(sessionMessages)
    .where(inArray(sessionMessages.sessionId, sessionIds))
    .orderBy(desc(sessionMessages.id));
}
