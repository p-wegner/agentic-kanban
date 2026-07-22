import {
  issues, projects, preferences, workspaces, sessions, agentSkills, projectStatuses,
  issueDependencies, workflowNodes,
} from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq, inArray, and, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function updateLatestSetupRunFields(
  workspaceId: string,
  run: {
    command: string | null;
    state: string;
    startedAt: string | null;
    endedAt: string | null;
    exitCode: number | null;
    durationMs: number | null;
    stdoutTail: string | null;
    stderrTail: string | null;
  },
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({
      latestSetupCommand: run.command,
      latestSetupState: run.state,
      latestSetupStartedAt: run.startedAt,
      latestSetupEndedAt: run.endedAt,
      latestSetupExitCode: run.exitCode,
      latestSetupDurationMs: run.durationMs,
      latestSetupStdoutTail: run.stdoutTail,
      latestSetupStderrTail: run.stderrTail,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaces.id, workspaceId));
}

export async function getIssueForWorkspaceCreate(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title, description: issues.description, priority: issues.priority })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function getProjectForWorkspaceCreate(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project
    ? [{
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        defaultSkillId: project.defaultSkillId,
        setupScript: project.setupScript,
        setupBlocking: project.setupBlocking,
        setupEnabled: project.setupEnabled,
        symlinkEnabled: project.symlinkEnabled,
        symlinkDirs: project.symlinkDirs,
        servicesConfig: project.servicesConfig ?? null,
      }]
    : [];
}

export async function getAgentSkillById(
  skillId: string,
  database: Database = db,
) {
  return database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

export async function getAllPreferences(database: Database = db) {
  return database.select().from(preferences);
}

export async function insertWorkspaceRecordRow(
  values: typeof workspaces.$inferInsert,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

export async function findOpenDirectWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(and(
      eq(workspaces.issueId, issueId),
      eq(workspaces.isDirect, true),
      ne(workspaces.status, "closed"),
    ))
    .limit(3);
}

export async function getIssueProjectId(
  issueId: string,
  database: Database = db,
) {
  return database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function updateWorkspaceLaunchFailure(
  workspaceId: string,
  values: { status: string; latestLaunchError: string; updatedAt: string },
  database: Database = db,
) {
  return setWorkspaceStatus(database, workspaceId, values.status as WorkspaceStatus, {
    now: values.updatedAt,
    set: { latestLaunchError: values.latestLaunchError },
  });
}

export async function getSessionsForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, status: sessions.status, pid: sessions.pid })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function getWorkspaceDeletionContext(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({
      workingDir: workspaces.workingDir,
      isDirect: workspaces.isDirect,
      branch: workspaces.branch,
      repoPath: projects.repoPath,
      projectId: issues.projectId,
      teardownScript: projects.teardownScript,
      setupEnabled: projects.setupEnabled,
      serviceState: workspaces.serviceState,
    })
    .from(workspaces)
    .leftJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function findWorkspacesByWorkingDir(
  workingDir: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.workingDir, workingDir));
}

export async function getSessionStatusesForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function updateWorkspaceClosed(
  workspaceId: string,
  values: { status: "closed"; workingDir: string | null; closedAt: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, "closed", {
    now: values.updatedAt,
    set: { workingDir: values.workingDir, closedAt: values.closedAt },
  });
}

export async function getWorkspaceIssueId(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function setWorkspaceReadyForMerge(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));
}

export async function getIssueProjectIdById(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function setWorkspaceWorkingDir(
  workspaceId: string,
  values: { workingDir: string; baseBranch: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, workspaceId));
}

/**
 * Generic PATCH-style workspace update backing `PATCH /api/workspaces/:id`. `updates` is
 * a caller-assembled bag of optional columns; when it carries `status`, route the write
 * through the `setWorkspaceStatus` authority (terminal-invariant guard included) with the
 * remaining columns applied atomically via `opts.set`, instead of a raw update that could
 * revive a closed+merged workspace.
 */
export async function applyWorkspaceUpdates(
  workspaceId: string,
  updates: Record<string, unknown>,
  database: Database = db,
): Promise<void> {
  const { status, updatedAt, ...rest } = updates;
  if (status !== undefined) {
    await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, {
      now: updatedAt as string | undefined,
      set: rest,
    });
    return;
  }
  await database.update(workspaces).set(updates).where(eq(workspaces.id, workspaceId));
}

export async function listStaleWorktreeRows(
  projectId: string | undefined,
  database: Database = db,
) {
  const conditions = [eq(workspaces.status, "closed")];
  if (projectId) {
    conditions.push(eq(issues.projectId, projectId));
  }
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      updatedAt: workspaces.updatedAt,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      projectId: issues.projectId,
      repoPath: projects.repoPath,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause);
}

export async function clearWorkspaceWorkingDir(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ workingDir: null, updatedAt: now })
    .where(eq(workspaces.id, workspaceId));
}

export async function getAgentSkillNameById(
  skillId: string,
  database: Database = db,
) {
  return database.select({ id: agentSkills.id, name: agentSkills.name }).from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

export async function findExistingWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id, status: workspaces.status, branch: workspaces.branch, isDirect: workspaces.isDirect })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));
}

export async function getDependenciesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.issueId, issueId),
      ),
    );
}

export async function getBlockerIssues(
  blockerIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, blockerIds));
}

export async function listCleanupWarningRows(
  projectId: string | undefined,
  database: Database = db,
) {
  const conditions = [
    eq(workspaces.status, "closed"),
    isNotNull(workspaces.cleanupWarning),
    ne(workspaces.cleanupWarning, ""),
  ];
  if (projectId) {
    conditions.push(eq(issues.projectId, projectId));
  }
  const whereClause = and(...conditions);

  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      cleanupWarning: workspaces.cleanupWarning,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      updatedAt: workspaces.updatedAt,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(whereClause);
}

export async function clearWorkspaceCleanupWarning(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces)
    .set({ cleanupWarning: null, updatedAt: now })
    .where(eq(workspaces.id, workspaceId));
}
