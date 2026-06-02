import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc, and, ne } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { isAnalyticsNoise } from "./session-filter.js";

export type LaunchFailureCategory =
  | "zero-output"   // session exited in <=1s or had zero tokens
  | "setup-failed"  // workspace setup script failed (non-zero exit)
  | "missing-worktree" // workingDir is null or missing
  | "session-error"; // session exited with non-zero exit code

export interface WorkspaceLaunchFailure {
  workspaceId: string;
  workspaceBranch: string;
  workspaceStatus: string;
  workingDir: string | null;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  provider: string | null;
  profile: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  failureCategory: LaunchFailureCategory;
  lastMessage: string | null;
  /** ISO timestamp of when the failure occurred (session end or workspace update) */
  failedAt: string;
}

export interface WorkspaceLaunchFailuresResponse {
  projectId: string;
  generatedAt: string;
  failures: WorkspaceLaunchFailure[];
}

/** A session is a zero-output launch failure if it lasted <=1000ms or had zero tokens */
function isZeroOutputSession(session: { startedAt: string; endedAt: string | null; stats: string | null }): boolean {
  if (!session.endedAt) return false;
  const durationMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  if (durationMs <= 1000) return true;
  if (session.stats) {
    try {
      const s = JSON.parse(session.stats) as Record<string, unknown>;
      // Zero input AND zero output tokens = no provider activity
      if ((s.inputTokens === 0 || s.inputTokens == null) && (s.outputTokens === 0 || s.outputTokens == null)) {
        return true;
      }
      // Explicit launch failure flag set by session-lifecycle
      if (s.launchFailure === true) return true;
    } catch { /* ignore bad JSON */ }
  }
  return false;
}

function extractFailureMessage(session: { stats: string | null } | null, setupStderr: string | null | undefined): string | null {
  if (setupStderr) return setupStderr.slice(-300).trim() || null;
  if (session?.stats) {
    try {
      const s = JSON.parse(session.stats) as Record<string, unknown>;
      if (typeof s.failureReason === "string" && s.failureReason) return s.failureReason;
    } catch { /* ignore */ }
  }
  return null;
}

export async function getWorkspaceLaunchFailures(
  projectId: string,
  database: Database,
): Promise<WorkspaceLaunchFailuresResponse> {
  // Resolve project
  const projectRows = await database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (projectRows.length === 0) throw new Error(`Project ${projectId} not found`);

  // Get non-terminal issue statuses
  const statusRows = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
  const terminalStatusIds = new Set(
    statusRows.filter(s => s.name === "Done" || s.name === "Cancelled").map(s => s.id),
  );
  const statusNameById = new Map(statusRows.map(s => [s.id, s.name]));

  // Get active (non-terminal) issues
  const issueRows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  const activeIssues = issueRows.filter(i => !terminalStatusIds.has(i.statusId));
  if (activeIssues.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), failures: [] };
  }

  const activeIssueIds = activeIssues.map(i => i.id);
  const issueById = new Map(activeIssues.map(i => [i.id, i]));

  // Get workspaces for active issues (non-closed)
  const workspaceRows = await database
    .select()
    .from(workspaces)
    .where(and(
      inArray(workspaces.issueId, activeIssueIds),
      ne(workspaces.status, "closed"),
    ));

  if (workspaceRows.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), failures: [] };
  }

  const wsIds = workspaceRows.map(w => w.id);

  // Get recent sessions for these workspaces
  const sessionRows = await database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));

  // Group sessions by workspaceId (most recent first, excluding analytics noise)
  const latestSessionByWs = new Map<string, typeof sessionRows[0]>();
  for (const session of sessionRows) {
    if (!latestSessionByWs.has(session.workspaceId) && !isAnalyticsNoise(session)) {
      latestSessionByWs.set(session.workspaceId, session);
    }
  }

  const failures: WorkspaceLaunchFailure[] = [];

  for (const ws of workspaceRows) {
    const issue = issueById.get(ws.issueId);
    if (!issue) continue;

    const issueStatusName = statusNameById.get(issue.statusId) ?? "Unknown";
    const latestSession = latestSessionByWs.get(ws.id) ?? null;

    // Check: missing worktree path
    if (!ws.isDirect && !ws.workingDir) {
      failures.push({
        workspaceId: ws.id,
        workspaceBranch: ws.branch,
        workspaceStatus: ws.status,
        workingDir: ws.workingDir,
        issueId: issue.id,
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        issueStatusName,
        provider: ws.provider ?? null,
        profile: ws.claudeProfile ?? null,
        sessionId: latestSession?.id ?? null,
        sessionStatus: latestSession?.status ?? null,
        sessionStartedAt: latestSession?.startedAt ?? null,
        sessionEndedAt: latestSession?.endedAt ?? null,
        failureCategory: "missing-worktree",
        lastMessage: extractFailureMessage(latestSession, null),
        failedAt: ws.updatedAt,
      });
      continue;
    }

    // Check: setup script failure
    if (ws.latestSetupState === "failed") {
      failures.push({
        workspaceId: ws.id,
        workspaceBranch: ws.branch,
        workspaceStatus: ws.status,
        workingDir: ws.workingDir,
        issueId: issue.id,
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        issueStatusName,
        provider: ws.provider ?? null,
        profile: ws.claudeProfile ?? null,
        sessionId: latestSession?.id ?? null,
        sessionStatus: latestSession?.status ?? null,
        sessionStartedAt: latestSession?.startedAt ?? null,
        sessionEndedAt: latestSession?.endedAt ?? null,
        failureCategory: "setup-failed",
        lastMessage: extractFailureMessage(null, ws.latestSetupStderrTail),
        failedAt: ws.latestSetupEndedAt ?? ws.updatedAt,
      });
      continue;
    }

    if (!latestSession) continue;

    // Check: zero-output session (1-second or zero-token provider failure)
    if (isZeroOutputSession(latestSession)) {
      failures.push({
        workspaceId: ws.id,
        workspaceBranch: ws.branch,
        workspaceStatus: ws.status,
        workingDir: ws.workingDir,
        issueId: issue.id,
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        issueStatusName,
        provider: ws.provider ?? null,
        profile: ws.claudeProfile ?? null,
        sessionId: latestSession.id,
        sessionStatus: latestSession.status,
        sessionStartedAt: latestSession.startedAt,
        sessionEndedAt: latestSession.endedAt,
        failureCategory: "zero-output",
        lastMessage: extractFailureMessage(latestSession, null),
        failedAt: latestSession.endedAt ?? latestSession.startedAt,
      });
      continue;
    }

    // Check: session exited with non-zero exit code
    if (
      latestSession.status === "stopped"
      && latestSession.exitCode !== null
      && latestSession.exitCode !== "0"
    ) {
      failures.push({
        workspaceId: ws.id,
        workspaceBranch: ws.branch,
        workspaceStatus: ws.status,
        workingDir: ws.workingDir,
        issueId: issue.id,
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        issueStatusName,
        provider: ws.provider ?? null,
        profile: ws.claudeProfile ?? null,
        sessionId: latestSession.id,
        sessionStatus: latestSession.status,
        sessionStartedAt: latestSession.startedAt,
        sessionEndedAt: latestSession.endedAt,
        failureCategory: "session-error",
        lastMessage: extractFailureMessage(latestSession, null),
        failedAt: latestSession.endedAt ?? latestSession.startedAt,
      });
    }
  }

  // Sort by failedAt descending (most recent first)
  failures.sort((a, b) => b.failedAt.localeCompare(a.failedAt));

  return { projectId, generatedAt: new Date().toISOString(), failures };
}
