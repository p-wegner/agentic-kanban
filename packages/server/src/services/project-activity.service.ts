import type { Database } from "../db/index.js";
import {
  getProjectActivityIssues,
  getProjectActivityWorkspaces,
  getProjectActivitySessions,
  getProjectActivityComments,
} from "../repositories/project-activity.repository.js";

export interface ProjectActivityEvent {
  id: string;
  type: string;
  summary: string;
  actor: string | null;
  timestamp: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  commentKind?: string | null;
}

export interface ProjectActivityResult {
  events: ProjectActivityEvent[];
  generatedAt: string;
}

export async function getProjectActivity(
  projectId: string,
  database: Database,
  limit = 100,
): Promise<ProjectActivityResult> {
  // Fetch all issues for the project
  const issueRows = await getProjectActivityIssues(projectId, database);

  if (issueRows.length === 0) {
    return { events: [], generatedAt: new Date().toISOString() };
  }

  const issueIds = issueRows.map((i) => i.id);
  const issueMap = new Map(issueRows.map((i) => [i.id, i]));

  const events: ProjectActivityEvent[] = [];

  // Issue created events
  for (const issue of issueRows) {
    events.push({
      id: `issue-created-${issue.id}`,
      type: "issue_created",
      summary: "Issue created",
      actor: "user",
      timestamp: issue.createdAt,
      issueId: issue.id,
      issueNumber: issue.issueNumber ?? null,
      issueTitle: issue.title,
    });

    if (issue.statusChangedAt && issue.statusChangedAt !== issue.createdAt) {
      events.push({
        id: `status-changed-${issue.id}`,
        type: "status_changed",
        summary: issue.statusName ? `Moved to ${issue.statusName}` : "Status changed",
        actor: null,
        timestamp: issue.statusChangedAt,
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
      });
    }
  }

  // Workspace events
  const wsRows = await getProjectActivityWorkspaces(issueIds, database);

  const wsIds = wsRows.map((w) => w.id);

  for (const ws of wsRows) {
    const issue = issueMap.get(ws.issueId)!;
    const provider = ws.provider ?? ws.claudeProfile ?? null;

    events.push({
      id: `workspace-created-${ws.id}`,
      type: "workspace_created",
      summary: `Workspace created on ${ws.branch}`,
      actor: "user",
      timestamp: ws.createdAt,
      issueId: issue.id,
      issueNumber: issue.issueNumber ?? null,
      issueTitle: issue.title,
      workspaceId: ws.id,
    });

    if (ws.mergedAt) {
      events.push({
        id: `workspace-merged-${ws.id}`,
        type: "workspace_merged",
        summary: "Branch merged",
        actor: provider,
        timestamp: ws.mergedAt,
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
        workspaceId: ws.id,
      });
    } else if (ws.closedAt) {
      events.push({
        id: `workspace-closed-${ws.id}`,
        type: "workspace_closed",
        summary: "Workspace closed",
        actor: provider,
        timestamp: ws.closedAt,
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
        workspaceId: ws.id,
      });
    }
  }

  // Session events (batch load all sessions for project workspaces)
  if (wsIds.length > 0) {
    const wsIssueMap = new Map(wsRows.map((w) => [w.id, w.issueId]));
    const sessionRows = await getProjectActivitySessions(wsIds, database);

    for (const sess of sessionRows) {
      const issueId = wsIssueMap.get(sess.workspaceId ?? "");
      if (!issueId) continue;
      const issue = issueMap.get(issueId);
      if (!issue) continue;
      const ws = wsRows.find((w) => w.id === sess.workspaceId);
      const provider = ws?.provider ?? ws?.claudeProfile ?? null;
      const actor = sess.executor ?? provider;

      const skillLabel = sess.skillName ? ` (${sess.skillName})` : "";
      events.push({
        id: `session-started-${sess.id}`,
        type: "session_started",
        summary: `Agent session started${skillLabel}`,
        actor,
        timestamp: sess.startedAt,
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
        workspaceId: sess.workspaceId,
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
          issueId: issue.id,
          issueNumber: issue.issueNumber ?? null,
          issueTitle: issue.title,
          workspaceId: sess.workspaceId,
          sessionId: sess.id,
        });
      }
    }
  }

  // Comment events
  const commentRows = await getProjectActivityComments(issueIds, database);

  for (const cmt of commentRows) {
    const issue = issueMap.get(cmt.issueId);
    if (!issue) continue;
    events.push({
      id: `comment-${cmt.id}`,
      type: "comment",
      summary: commentSummary(cmt.kind, cmt.body),
      actor: cmt.author,
      timestamp: cmt.createdAt,
      issueId: issue.id,
      issueNumber: issue.issueNumber ?? null,
      issueTitle: issue.title,
      workspaceId: cmt.workspaceId,
      commentKind: cmt.kind,
    });
  }

  // Sort newest-first, take top N
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    events: events.slice(0, limit),
    generatedAt: new Date().toISOString(),
  };
}

function commentSummary(kind: string, body: string): string {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 80);
  const suffix = body.length > 80 ? "..." : "";
  switch (kind) {
    case "preflight-verdict": return preview + suffix;
    case "preflight-clarification": return `Preflight clarification: ${preview}${suffix}`;
    case "agent-question": return `Agent question: ${preview}${suffix}`;
    case "merge-attempt": return `Merge attempt: ${preview}${suffix}`;
    case "note": return `Note: ${preview}${suffix}`;
    default: return preview + suffix;
  }
}
