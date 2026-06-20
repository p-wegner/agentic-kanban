import type { Database } from "../db/index.js";
import { NotFoundError } from "../errors/index.js";
import { isAnalyticsNoise } from "./session-filter.js";
import { isCodexUsageLimitStats } from "./codex-rate-limit.js";
import {
  getNonClosedWorkspacesForIssues,
  getProjectIdOrNull,
  getProjectIssueRows,
  getProjectStatusRows,
  getSessionsForWorkspacesDesc,
} from "../repositories/workspace-launch-failures.repository.js";

export type LaunchFailureCategory =
  | "zero-output"   // session exited in <=1s or had zero tokens
  | "rate-limited"  // provider quota/usage limit blocked launch
  | "setup-failed"  // workspace setup script failed (non-zero exit)
  | "preflight-failed" // launch preflight refused before a session row existed
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
  recentFailureCount: number;
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

function isRateLimitedSession(session: { stats: string | null }): boolean {
  return isCodexUsageLimitStats(session.stats);
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
  const projectIdResolved = await getProjectIdOrNull(projectId, database);
  if (!projectIdResolved) throw new NotFoundError(`Project ${projectId} not found`);

  // Get non-terminal issue statuses
  const statusRows = await getProjectStatusRows(projectId, database);
  const terminalStatusIds = new Set(
    statusRows.filter(s => s.name === "Done" || s.name === "Cancelled").map(s => s.id),
  );
  const statusNameById = new Map(statusRows.map(s => [s.id, s.name]));

  // Get active (non-terminal) issues
  const issueRows = await getProjectIssueRows(projectId, database);
  const activeIssues = issueRows.filter(i => !terminalStatusIds.has(i.statusId));
  if (activeIssues.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), failures: [] };
  }

  const activeIssueIds = activeIssues.map(i => i.id);
  const issueById = new Map(activeIssues.map(i => [i.id, i]));

  // Get workspaces for active issues (non-closed)
  const workspaceRows = await getNonClosedWorkspacesForIssues(activeIssueIds, database);

  if (workspaceRows.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), failures: [] };
  }

  const wsIds = workspaceRows.map(w => w.id);

  // Get recent sessions for these workspaces
  const sessionRows = await getSessionsForWorkspacesDesc(wsIds, database);

  // Group sessions by workspaceId (most recent first, excluding analytics noise)
  const latestSessionByWs = new Map<string, typeof sessionRows[0]>();
  const allSessionsByWs = new Map<string, typeof sessionRows>();
  for (const session of sessionRows) {
    if (isAnalyticsNoise(session)) continue;
    if (!latestSessionByWs.has(session.workspaceId)) {
      latestSessionByWs.set(session.workspaceId, session);
    }
    const arr = allSessionsByWs.get(session.workspaceId) ?? [];
    arr.push(session);
    allSessionsByWs.set(session.workspaceId, arr);
  }

  function countRecentFailures(wsId: string): number {
    const wsessions = allSessionsByWs.get(wsId) ?? [];
    return wsessions.filter(s =>
      isRateLimitedSession(s) ||
      (s.endedAt && isZeroOutputSession(s)) ||
      (s.status === "stopped" && s.exitCode !== null && s.exitCode !== "0"),
    ).length;
  }

  type WsRow = typeof workspaceRows[number];
  type SessionRow = typeof sessionRows[number];
  type IssueRow = typeof activeIssues[number];
  type FailureClassification = Pick<WorkspaceLaunchFailure, "failureCategory" | "lastMessage" | "failedAt">;

  /**
   * Decide whether (and how) a workspace counts as a launch failure. Checks run in
   * priority order; the first match wins. Returns null when the workspace launched
   * cleanly. Order matters — preflight/worktree/setup failures are reported even
   * when a later session also looks off.
   */
  function classifyWorkspaceFailure(ws: WsRow, latestSession: SessionRow | null): FailureClassification | null {
    if (ws.latestLaunchError) {
      return { failureCategory: "preflight-failed", lastMessage: ws.latestLaunchError, failedAt: ws.updatedAt };
    }
    if (!ws.isDirect && !ws.workingDir) {
      return { failureCategory: "missing-worktree", lastMessage: extractFailureMessage(latestSession, null), failedAt: ws.updatedAt };
    }
    if (ws.latestSetupState === "failed") {
      return { failureCategory: "setup-failed", lastMessage: extractFailureMessage(null, ws.latestSetupStderrTail), failedAt: ws.latestSetupEndedAt ?? ws.updatedAt };
    }
    if (!latestSession) return null;
    if (isRateLimitedSession(latestSession)) {
      return { failureCategory: "rate-limited", lastMessage: extractFailureMessage(latestSession, null), failedAt: latestSession.endedAt ?? latestSession.startedAt };
    }
    if (isZeroOutputSession(latestSession)) {
      return { failureCategory: "zero-output", lastMessage: extractFailureMessage(latestSession, null), failedAt: latestSession.endedAt ?? latestSession.startedAt };
    }
    if (latestSession.status === "stopped" && latestSession.exitCode !== null && latestSession.exitCode !== "0") {
      return { failureCategory: "session-error", lastMessage: extractFailureMessage(latestSession, null), failedAt: latestSession.endedAt ?? latestSession.startedAt };
    }
    return null;
  }

  /** Assemble a WorkspaceLaunchFailure from the common workspace/issue/session fields + the classification. */
  function buildFailure(
    ws: WsRow,
    issue: IssueRow,
    issueStatusName: string,
    latestSession: SessionRow | null,
    classification: FailureClassification,
  ): WorkspaceLaunchFailure {
    return {
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
      failureCategory: classification.failureCategory,
      lastMessage: classification.lastMessage,
      failedAt: classification.failedAt,
      recentFailureCount: countRecentFailures(ws.id),
    };
  }

  const failures: WorkspaceLaunchFailure[] = [];

  for (const ws of workspaceRows) {
    const issue = issueById.get(ws.issueId);
    if (!issue) continue;

    const issueStatusName = statusNameById.get(issue.statusId) ?? "Unknown";
    const latestSession = latestSessionByWs.get(ws.id) ?? null;

    const classification = classifyWorkspaceFailure(ws, latestSession);
    if (!classification) continue;

    failures.push(buildFailure(ws, issue, issueStatusName, latestSession, classification));
  }

  // Sort by failedAt descending (most recent first)
  failures.sort((a, b) => b.failedAt.localeCompare(a.failedAt));

  return { projectId, generatedAt: new Date().toISOString(), failures };
}
