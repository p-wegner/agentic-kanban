import { issues, projects, workspaces, agentSkills, projectStatuses, issueDependencies, workflowNodes } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq, inArray, and, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";
import { setWorkspaceWorkingDir as setWorkspaceWorkingDirShared } from "@agentic-kanban/shared/lib/workspace-git-state";
import { issueIdentityColumns } from "./projections.js";

export async function setWorkspaceWorkingDir(
  workspaceId: string,
  values: { workingDir: string; baseBranch: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, workspaceId));
  await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { workingDir: values.workingDir, baseBranch: values.baseBranch }, database);
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

/**
 * Clear a workspace's `workingDir` on BOTH sides — the column and the leading `repos` row
 * (#226).
 *
 * The only sanctioned way to clear it. `setWorkspaceStatus`'s `set` escape hatch used to be
 * the other way and could not mirror, so four close paths left the row pointing at a
 * torn-down worktree; its type now rejects these columns outright, which routes them here.
 */
export async function clearWorkspaceWorkingDir(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceWorkingDirShared(database, workspaceId, null, now);
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
      ...issueIdentityColumns,
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
