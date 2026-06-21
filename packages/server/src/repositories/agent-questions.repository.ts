import { sessions, sessionMessages, workspaces, issues, projectStatuses, issueComments, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, ne, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

/** Resolve the issueId backing a workspace (for attaching an agent-question comment). */
export async function getWorkspaceIssueId(
  workspaceId: string,
  database: Database = db,
): Promise<string | undefined> {
  const wsRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return wsRows[0]?.issueId;
}

export interface PendingQuestionWorkspaceRow {
  workspaceId: string;
  workspaceStatus: string;
  workspaceClosedAt: string | null;
  readyForMerge: boolean;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueDescription: string | null;
  issueStatusName: string | null;
  issueCurrentNodeId: string | null;
  issueCurrentNodeType: string | null;
}

/**
 * Pull all non-closed workspaces+issues for a project (one query). Includes the
 * workspace status/closedAt/readyForMerge and the issue's status-column name so
 * staleness can be computed per card without extra round-trips.
 */
export async function getPendingQuestionWorkspaces(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
      workspaceClosedAt: workspaces.closedAt,
      readyForMerge: workspaces.readyForMerge,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueStatusName: projectStatuses.name,
      issueCurrentNodeId: issues.currentNodeId,
      issueCurrentNodeType: workflowNodes.nodeType,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(and(eq(issues.projectId, projectId), ne(workspaces.status, "closed")));
}

/** Recent sessions (any status) for a workspace, newest first, limited to 10. */
export async function getRecentSessionsForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, startedAt: sessions.startedAt, endedAt: sessions.endedAt, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(10);
}

/** DB-backed stdout rows for a session (fallback when the .out file is absent). */
export async function getSessionStdoutMessages(
  sessionId: string,
  database: Database = db,
): Promise<Array<{ type: string; data: string | null }>> {
  return database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
}

/**
 * Synthetic (MCP clarify_or_propose) questions live in `agent-question` issue
 * comments. Only that kind can carry the `mcp_clarify_or_propose` payload, so
 * filter by kind instead of scanning every comment of the project.
 */
export async function getSyntheticQuestionComments(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      workspaceId: issueComments.workspaceId,
      body: issueComments.body,
      payload: issueComments.payload,
      createdAt: issueComments.createdAt,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(issueComments)
    .innerJoin(issues, eq(issueComments.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), eq(issueComments.kind, "agent-question")))
    .orderBy(desc(issueComments.createdAt));
}

/** Fetch a project row by id (for starting a butler session on demand). */
export async function getProjectRow(
  projectId: string,
  database: Database = db,
) {
  return getProjectById(projectId, database);
}
