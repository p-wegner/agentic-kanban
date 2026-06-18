import {
  workspaces,
  issues,
  projects,
  sessions,
  sessionMessages,
  diffComments,
  projectStatuses,
  agentSkills,
  issueArtifacts,
  issueComments,
  repos,
  testRetryDecisions,
  workflowTransitions,
} from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import { desc, eq, inArray, sql } from "drizzle-orm";

type Project = typeof projects.$inferSelect;
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

type Workspace = typeof workspaces.$inferSelect;

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function mapSymlinkRun(row: {
  latestSymlinkState: string | null;
  latestSymlinkStartedAt: string | null;
  latestSymlinkEndedAt: string | null;
  latestSymlinkDirs: string | null;
  latestSymlinkLinked: string | null;
  latestSymlinkSkipped: string | null;
  latestSymlinkFailed: string | null;
  latestSymlinkError: string | null;
}): WorkspaceSymlinkRun | null {
  if (!row.latestSymlinkState) return null;
  return {
    state: row.latestSymlinkState as WorkspaceSymlinkRun["state"],
    dirs: parseJsonArray<string>(row.latestSymlinkDirs, []),
    linked: parseJsonArray<string>(row.latestSymlinkLinked, []),
    skipped: parseJsonArray<string>(row.latestSymlinkSkipped, []),
    failed: parseJsonArray<{ dir: string; error: string }>(row.latestSymlinkFailed, []),
    startedAt: row.latestSymlinkStartedAt,
    endedAt: row.latestSymlinkEndedAt,
    error: row.latestSymlinkError,
  };
}

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
): Promise<Workspace | null> {
  const rows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
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
  extra: Partial<Omit<Workspace, "id" | "status">> = {},
  database: Database = db,
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .update(workspaces)
    .set({ status, updatedAt: now, ...extra } as Partial<Workspace>)
    .where(eq(workspaces.id, workspaceId));
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

  const projectRows = await database
    .select()
    .from(projects)
    .where(eq(projects.id, issueRows[0].projectId))
    .limit(1);
  if (projectRows.length === 0) throw new Error("Project not found");

  const project = projectRows[0];
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

  const projectRows = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, issueRows[0].projectId))
    .limit(1);
  if (projectRows.length === 0) throw new Error("Project not found");

  return { repoPath: projectRows[0].repoPath, defaultBranch: projectRows[0].defaultBranch };
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
      await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, issueId));
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
      await database.update(issues).set({ statusId: inProgress.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, issueId));
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to In Progress:", err);
  }
}

async function deleteWorkspaceCascadeRows(
  workspaceId: string,
  database: Database,
): Promise<void> {
  const wsSessions = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
  const sessionIds = wsSessions.map(s => s.id);

  await database.delete(workflowTransitions).where(eq(workflowTransitions.workspaceId, workspaceId));
  await database.delete(testRetryDecisions).where(eq(testRetryDecisions.workspaceId, workspaceId));
  await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
  await database.delete(issueArtifacts).where(eq(issueArtifacts.workspaceId, workspaceId));
  await database.delete(issueComments).where(eq(issueComments.workspaceId, workspaceId));
  await database.delete(repos).where(eq(repos.workspaceId, workspaceId));
  if (sessionIds.length > 0) {
    await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
  }
  await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

/** Cascade delete a workspace and every table that directly FK-references it. */
export async function deleteWorkspaceCascade(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database.run(sql.raw("begin immediate"));
  try {
    await deleteWorkspaceCascadeRows(workspaceId, database);
    await database.run(sql.raw("commit"));
  } catch (err) {
    await database.run(sql.raw("rollback")).catch(() => {});
    throw err;
  }
}

export interface WorkspaceDetails {
  id: string;
  issueId: string;
  branch: string | null;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  requiresReview: boolean;
  thoroughReview: boolean;
  readyForMerge: boolean;
  status: string;
  claudeProfile: string | null;
  agentCommand: string | null;
  provider: string | null;
  model: string | null;
  pendingPlanPath: string | null;
  skillId: string | null;
  skillName: string | null;
  contextPrimer: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  scorecard: { score: number } | null;
  lastSessionAt: string | null;
  sessionStatus: string | null;
  lastSessionTriggerType: string | null;
  contextTokens: number | null;
  lastTool: string | null;
  latestSetup: WorkspaceSetupRun | null;
  latestSymlink: WorkspaceSymlinkRun | null;
  createdAt: string;
  updatedAt: string;
  issue: { title: string; priority: string | null };
}

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

  let contextTokens: number | null = null;
  let lastTool: string | null = null;
  if (sess?.stats) {
    try {
      const p = JSON.parse(sess.stats) as Record<string, unknown>;
      const explicit = (p.contextTokens as number) ?? 0;
      const tokens = explicit || ((p.inputTokens as number) ?? 0) + ((p.cacheReadTokens as number) ?? 0);
      if (tokens) contextTokens = tokens;
      if (typeof p.lastTool === "string" && p.lastTool) lastTool = p.lastTool;
    } catch { /* ignore */ }
  }

  return {
    id: row.id,
    issueId: row.issueId,
    branch: row.branch,
    workingDir: row.workingDir,
    baseBranch: row.baseBranch,
    isDirect: row.isDirect,
    planMode: row.planMode,
    includeVisualProof: row.includeVisualProof,
    requiresReview: row.requiresReview,
    thoroughReview: row.thoroughReview,
    readyForMerge: row.readyForMerge,
    status: row.status,
    claudeProfile: row.claudeProfile,
    agentCommand: row.agentCommand,
    provider: row.provider,
    model: row.model,
    pendingPlanPath: row.pendingPlanPath,
    skillId: row.skillId,
    skillName: row.skillName ?? null,
    contextPrimer: row.contextPrimer ?? null,
    closedAt: row.closedAt,
    mergedAt: row.mergedAt,
    conflicts: row.conflictCacheHasConflicts !== null && row.conflictCacheHasConflicts !== undefined
      ? { hasConflicts: row.conflictCacheHasConflicts, conflictingFiles: parseJsonArray<string>(row.conflictCacheFiles, []) }
      : null,
    diffStats: row.diffStatCacheFilesChanged !== null && row.diffStatCacheFilesChanged !== undefined
      ? { filesChanged: row.diffStatCacheFilesChanged, insertions: row.diffStatCacheInsertions ?? 0, deletions: row.diffStatCacheDeletions ?? 0 }
      : null,
    scorecard: row.scorecardScore !== null && row.scorecardScore !== undefined ? { score: row.scorecardScore } : null,
    lastSessionAt: sess ? (sess.status === "running" ? sess.startedAt : sess.endedAt) : null,
    sessionStatus: sess?.status ?? null,
    lastSessionTriggerType: sess?.triggerType ?? null,
    contextTokens,
    lastTool,
    latestSetup: row.latestSetupState ? {
      command: row.latestSetupCommand,
      state: row.latestSetupState as WorkspaceSetupRun["state"],
      startedAt: row.latestSetupStartedAt,
      endedAt: row.latestSetupEndedAt,
      exitCode: row.latestSetupExitCode,
      durationMs: row.latestSetupDurationMs,
      stdoutTail: row.latestSetupStdoutTail,
      stderrTail: row.latestSetupStderrTail,
    } : null,
    latestSymlink: mapSymlinkRun(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    issue: { title: row.issueTitle, priority: row.issuePriority },
  };
}
