import { sessions, sessionMessages, workspaces, issues, projectStatuses, issueComments, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, ne, and, desc, gte } from "drizzle-orm";
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
  issueStatusName: string | null;
  issueCurrentNodeId: string | null;
  issueCurrentNodeType: string | null;
}

/**
 * Pull all non-closed workspaces+issues for a project (one query). Includes the
 * workspace status/closedAt/readyForMerge and the issue's status-column name so
 * staleness can be computed per card without extra round-trips.
 *
 * Deliberately does NOT select `issues.description` (#418 G17): this runs per
 * poll for every open workspace, and the description was only consumed on the
 * rare uncached-recommendation branch — the listing fetches it lazily there.
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

/**
 * Bound for the DB stdout fallback (#401). The caller (agent-questions/listing →
 * extractQuestionsFromSession) looks for `result` events carrying AskUserQuestion
 * permission denials — by construction one of the LAST rows a session writes (the
 * .out-file fast path reads only a 256 KB tail for the same reason). The unbounded
 * select pulled a session's whole message history (data payload included) through
 * the loop on every fallback. 50 newest rows comfortably covers the terminal result
 * event plus trailing noise.
 */
const STDOUT_FALLBACK_ROW_LIMIT = 50;

/** DB-backed stdout rows for a session (fallback when the .out file is absent). */
export async function getSessionStdoutMessages(
  sessionId: string,
  database: Database = db,
): Promise<Array<{ type: string; data: string | null }>> {
  const rows = await database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(STDOUT_FALLBACK_ROW_LIMIT);
  // Restore ascending (insertion) order — the unbounded query returned rowid order,
  // and question extraction pushes matches in iteration order.
  return rows.reverse();
}

/**
 * Bounds for the synthetic-question comment scan (#418 G17). Every answered
 * question ALSO writes an `agent-question` comment (durable history), so this
 * table grows for the project's lifetime — the unbounded select parsed every
 * historical payload on each poll. The `createdAt` floor mirrors
 * `AGENT_QUESTION_MARKER_TTL_MS` (30 days): once a question's answered marker
 * has been swept, resurfacing it would be wrong anyway, so older comments can
 * never contribute a pending question. The row cap is a hard safety net on top.
 */
export const SYNTHETIC_QUESTION_COMMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNTHETIC_QUESTION_COMMENT_LIMIT = 200;

/**
 * Synthetic (MCP clarify_or_propose) questions live in `agent-question` issue
 * comments. Only that kind can carry the `mcp_clarify_or_propose` payload, so
 * filter by kind instead of scanning every comment of the project. Bounded by a
 * created_at floor + LIMIT (see above); the unused `body` column is not selected
 * (the listing only parses `payload`).
 *
 * `now` is injectable for deterministic tests (defaults to wall clock).
 */
export async function getSyntheticQuestionComments(
  projectId: string,
  database: Database = db,
  opts?: { now?: string },
) {
  const nowMs = opts?.now ? new Date(opts.now).getTime() : Date.now();
  const floor = new Date(nowMs - SYNTHETIC_QUESTION_COMMENT_WINDOW_MS).toISOString();
  return database
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      workspaceId: issueComments.workspaceId,
      payload: issueComments.payload,
      createdAt: issueComments.createdAt,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(issueComments)
    .innerJoin(issues, eq(issueComments.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      eq(issueComments.kind, "agent-question"),
      gte(issueComments.createdAt, floor),
    ))
    .orderBy(desc(issueComments.createdAt))
    .limit(SYNTHETIC_QUESTION_COMMENT_LIMIT);
}

/** Fetch a project row by id (for starting a butler session on demand). */
export async function getProjectRow(
  projectId: string,
  database: Database = db,
) {
  return getProjectById(projectId, database);
}
