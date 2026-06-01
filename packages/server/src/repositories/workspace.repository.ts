import { workspaces, issues, projects, sessions, sessionMessages, diffComments, projectStatuses } from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import { eq, inArray } from "drizzle-orm";

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

/** Cascade delete a workspace: diff comments → session messages → sessions → workspace record. */
export async function deleteWorkspaceCascade(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  const wsSessions = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));

  await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
  if (wsSessions.length > 0) {
    await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, wsSessions.map(s => s.id)));
  }
  await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
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
  readyForMerge: boolean;
  status: string;
  claudeProfile: string | null;
  agentCommand: string | null;
  provider: string | null;
  contextPrimer: string | null;
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
      readyForMerge: workspaces.readyForMerge,
      status: workspaces.status,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      contextPrimer: workspaces.contextPrimer,
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
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(workspaces.id, workspaceId));

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    issueId: row.issueId,
    branch: row.branch,
    workingDir: row.workingDir,
    baseBranch: row.baseBranch,
    isDirect: row.isDirect,
    planMode: row.planMode,
    includeVisualProof: row.includeVisualProof,
    readyForMerge: row.readyForMerge,
    status: row.status,
    claudeProfile: row.claudeProfile,
    agentCommand: row.agentCommand,
    provider: row.provider,
    contextPrimer: row.contextPrimer ?? null,
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
