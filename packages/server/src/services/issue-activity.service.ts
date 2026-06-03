import { eq, asc } from "drizzle-orm";
import { workspaces, sessions, issueComments, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export type ActivityEventType =
  | "issue_created"
  | "status_changed"
  | "workspace_created"
  | "workspace_launched"
  | "workspace_merged"
  | "workspace_closed"
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "session_stopped"
  | "comment";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  summary: string;
  actor: string | null;
  timestamp: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  commentKind?: string | null;
}

export interface IssueActivityResult {
  events: ActivityEvent[];
}

export async function getIssueActivity(issueId: string, database: Database): Promise<IssueActivityResult | null> {
  // Verify issue exists and fetch creation/status data
  const issueRows = await database
    .select({
      id: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, issueId))
    .limit(1);

  if (issueRows.length === 0) return null;

  const issue = issueRows[0];
  const events: ActivityEvent[] = [];

  // Issue created
  events.push({
    id: `issue-created-${issueId}`,
    type: "issue_created",
    summary: "Issue created",
    actor: "user",
    timestamp: issue.createdAt,
  });

  // Status changed (only if changed after creation — statusChangedAt is set on explicit moves)
  if (issue.statusChangedAt && issue.statusChangedAt !== issue.createdAt) {
    events.push({
      id: `status-changed-${issueId}`,
      type: "status_changed",
      summary: issue.statusName ? `Moved to ${issue.statusName}` : "Status changed",
      actor: null,
      timestamp: issue.statusChangedAt,
    });
  }

  // Workspaces and their sessions
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId))
    .orderBy(asc(workspaces.createdAt));

  for (const ws of wsRows) {
    const provider = ws.provider ?? ws.claudeProfile ?? null;

    events.push({
      id: `workspace-created-${ws.id}`,
      type: "workspace_created",
      summary: `Workspace created on ${ws.branch}`,
      actor: "user",
      timestamp: ws.createdAt,
      workspaceId: ws.id,
    });

    if (ws.mergedAt) {
      events.push({
        id: `workspace-merged-${ws.id}`,
        type: "workspace_merged",
        summary: `Branch merged`,
        actor: provider,
        timestamp: ws.mergedAt,
        workspaceId: ws.id,
      });
    } else if (ws.closedAt) {
      events.push({
        id: `workspace-closed-${ws.id}`,
        type: "workspace_closed",
        summary: `Workspace closed`,
        actor: provider,
        timestamp: ws.closedAt,
        workspaceId: ws.id,
      });
    }

    const sessionRows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, ws.id))
      .orderBy(asc(sessions.startedAt));

    for (const sess of sessionRows) {
      const actor = sess.executor ?? provider;

      events.push({
        id: `session-started-${sess.id}`,
        type: "session_started",
        summary: skillLabel(sess.skillName) ? `Agent session started (${skillLabel(sess.skillName)})` : "Agent session started",
        actor,
        timestamp: sess.startedAt,
        workspaceId: ws.id,
        sessionId: sess.id,
      });

      if (sess.endedAt) {
        const exitCode = sess.exitCode;
        const failed = exitCode !== null && exitCode !== "0";
        const stopped = sess.status === "stopped";
        events.push({
          id: `session-ended-${sess.id}`,
          type: failed ? "session_failed" : stopped ? "session_stopped" : "session_completed",
          summary: failed
            ? `Session failed (exit ${exitCode})`
            : stopped
            ? "Session stopped"
            : "Session completed",
          actor,
          timestamp: sess.endedAt,
          workspaceId: ws.id,
          sessionId: sess.id,
        });
      }
    }
  }

  // Comments (preflight clarifications, agent questions, merge attempts, notes)
  const commentRows = await database
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(asc(issueComments.createdAt));

  for (const cmt of commentRows) {
    events.push({
      id: `comment-${cmt.id}`,
      type: "comment",
      summary: commentSummary(cmt.kind, cmt.body),
      actor: cmt.author,
      timestamp: cmt.createdAt,
      workspaceId: cmt.workspaceId,
      commentKind: cmt.kind,
    });
  }

  // Sort newest-first
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { events };
}

function skillLabel(skillName: string | null | undefined): string {
  if (!skillName) return "";
  return skillName;
}

function commentSummary(kind: string, body: string): string {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 80);
  const suffix = body.length > 80 ? "..." : "";
  switch (kind) {
    case "preflight-clarification": return `Preflight clarification: ${preview}${suffix}`;
    case "agent-question": return `Agent question: ${preview}${suffix}`;
    case "merge-attempt": return `Merge attempt: ${preview}${suffix}`;
    case "note": return `Note: ${preview}${suffix}`;
    default: return preview + suffix;
  }
}
