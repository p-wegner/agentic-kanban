import { workspaces, issues, projectStatuses, issueDependencies, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { setWorkspaceStatus, type WorkspaceStatus } from "./workspace-status.repository.js";

export async function getDependentsOf(
  mergedIssueId: string,
  database: Database = db,
) {
  return database
    .select({ issueId: issueDependencies.issueId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.dependsOnId, mergedIssueId),
      inArray(issueDependencies.type, ["depends_on", "blocked_by"]),
    ));
}

export async function getProjectStatusesForFollowup(
  projectId: string,
  database: Database = db,
) {
  return database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
}

export async function getProjectForFollowup(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? [project] : [];
}

export async function getBlockingDepsForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ dependsOnId: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.issueId, issueId),
      inArray(issueDependencies.type, ["depends_on", "blocked_by"]),
    ));
}

export async function getDepIssueStatusRows(
  depIssueIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, depIssueIds));
}

export async function getWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));
}

export async function getIssueById(
  issueId: string,
  database: Database = db,
) {
  return database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function insertFollowupWorkspace(
  values: {
    id: string;
    issueId: string;
    branch: string;
    status: string;
    workingDir: string;
    baseBranch: string;
    isDirect: boolean;
    planMode: boolean;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

export async function updateIssueStatus(
  issueId: string,
  values: { statusId: string; updatedAt: string; statusChangedAt: string },
  database: Database = db,
): Promise<void> {
  await transitionIssueStatus(database, issueId, values.statusId, { now: values.updatedAt });
}

export async function updateWorkspaceStatus(
  workspaceId: string,
  values: { status: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, values.status as WorkspaceStatus, { now: values.updatedAt });
}
