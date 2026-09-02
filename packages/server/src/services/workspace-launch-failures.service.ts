import { readSessionStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import type { Database } from "../db/index.js";
import { NotFoundError } from "../errors/index.js";
import { isAnalyticsNoise } from "./session-filter.js";
import { readUsageLimitStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import { getDirtyTrackedSourceFiles } from "./dirty-main-checkout.js";
import { getProjectById } from "../repositories/project.repository.js";
import { revParse, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import { isLaunchFailedSession } from "./session-launch-failure.js";
import {
  getNonClosedWorkspacesForIssues,
  getProjectIssueRows,
  getProjectStatusRows,
  getSessionsForWorkspacesDesc,
} from "../repositories/workspace-launch-failures.repository.js";

export type LaunchFailureCategory =
  | "zero-output"   // session stamped with an explicit launchFailure/success=false signal by the lifecycle
  | "rate-limited"  // provider quota/usage limit blocked launch
  | "setup-failed"  // workspace setup script failed (non-zero exit)
  | "preflight-failed" // launch preflight refused before a session row existed
  | "missing-worktree" // workingDir is null or missing
  | "session-error" // session exited with non-zero exit code
  | "empty-branch-dirty-main"; // idle with 0 unique commits WHILE the project's main checkout is dirty — likely wrote into main instead of the worktree (#218)

/** Git probes behind the empty-branch-dirty-main check — injectable so tests never spawn real git. */
export interface WorkspaceLaunchFailureGitDeps {
  revParse: (repoPath: string, ref: string) => Promise<string>;
  countUniqueCommits: (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;
  getDirtyTrackedSourceFiles: (repoPath: string) => Promise<string[]>;
}

const defaultGitDeps: WorkspaceLaunchFailureGitDeps = { revParse, countUniqueCommits, getDirtyTrackedSourceFiles };

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

/**
 * Re-exported under this file's historical name; the definition itself now lives in
 * `session-launch-failure.ts` so the workspace TIMELINE cannot drift back into a second,
 * disagreeing one (#1003). The reasoning for trusting an explicit lifecycle signal over any
 * duration/token heuristic is documented there.
 */
const isZeroOutputSession = isLaunchFailedSession;

/** Provider-neutral since #542 — this used to see a Codex quota death but not a Claude one. */
function isRateLimitedSession(session: { stats: string | null }): boolean {
  return readUsageLimitStats(session.stats) !== null;
}

function extractFailureMessage(session: { stats: string | null } | null, setupStderr: string | null | undefined): string | null {
  if (setupStderr) return setupStderr.slice(-300).trim() || null;
  if (session?.stats) {
    try {
      const s = readSessionStats(session.stats);
      if (typeof s.failureReason === "string" && s.failureReason) return s.failureReason;
    } catch { /* ignore */ }
  }
  return null;
}

export async function getWorkspaceLaunchFailures(
  projectId: string,
  database: Database,
  gitDeps: WorkspaceLaunchFailureGitDeps = defaultGitDeps,
): Promise<WorkspaceLaunchFailuresResponse> {
  // Resolve project
  const found = await getProjectById(projectId, database);
  if (!found) throw new NotFoundError(`Project ${projectId} not found`);
  // Re-bound to a non-nullable const: the nested helpers below capture `project`, and TS does
  // not carry the narrowing above into a hoisted function declaration.
  const project = found;

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

  // #218: a workspace that goes idle with 0 unique commits on its branch WHILE the
  // project's main checkout sits dirty is a strong signal the agent wrote into main
  // instead of its own worktree — cheap enough to check on every read of this panel,
  // but only worth the git spawns once we already know main is dirty (checked once,
  // not per workspace) and only for workspaces no other check already flagged.
  let dirtyMainFiles: string[] = [];
  if (project.repoPath) {
    try {
      dirtyMainFiles = await gitDeps.getDirtyTrackedSourceFiles(project.repoPath);
    } catch { /* best-effort — a git error here just skips this one signal */ }
  }

  async function checkEmptyBranchDirtyMain(ws: WsRow): Promise<FailureClassification | null> {
    if (dirtyMainFiles.length === 0) return null;
    if (ws.status !== "idle" || ws.isDirect || !ws.workingDir || !ws.branch || !project.repoPath) return null;
    const baseBranch = ws.baseBranch || project.defaultBranch;
    if (!baseBranch) return null;
    try {
      const branchSha = await gitDeps.revParse(project.repoPath, ws.branch);
      const baseSha = await gitDeps.revParse(project.repoPath, baseBranch);
      const uniqueCommits = await gitDeps.countUniqueCommits(project.repoPath, baseSha, branchSha);
      if (uniqueCommits > 0) return null;
    } catch {
      return null; // can't resolve refs — don't guess
    }
    return {
      failureCategory: "empty-branch-dirty-main",
      lastMessage: `Branch has 0 unique commits relative to ${baseBranch} while the project's main checkout has ${dirtyMainFiles.length} uncommitted tracked change(s) (${dirtyMainFiles.slice(0, 3).join(", ")}${dirtyMainFiles.length > 3 ? ", ..." : ""}) — the agent likely wrote into the main checkout instead of this workspace's worktree.`,
      failedAt: ws.updatedAt,
    };
  }

  const failures: WorkspaceLaunchFailure[] = [];

  for (const ws of workspaceRows) {
    const issue = issueById.get(ws.issueId);
    if (!issue) continue;

    const issueStatusName = statusNameById.get(issue.statusId) ?? "Unknown";
    const latestSession = latestSessionByWs.get(ws.id) ?? null;

    const classification = classifyWorkspaceFailure(ws, latestSession) ?? await checkEmptyBranchDirtyMain(ws);
    if (!classification) continue;

    failures.push(buildFailure(ws, issue, issueStatusName, latestSession, classification));
  }

  // Sort by failedAt descending (most recent first)
  failures.sort((a, b) => b.failedAt.localeCompare(a.failedAt));

  return { projectId, generatedAt: new Date().toISOString(), failures };
}
