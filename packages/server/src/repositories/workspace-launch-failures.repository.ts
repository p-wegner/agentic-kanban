import { projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectIdOrNull(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const project = await getProjectById(projectId, database);
  return project?.id ?? null;
}

export async function getProjectStatusRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

export async function getProjectIssueRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

export async function getNonClosedWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(workspaces)
    .where(and(
      inArray(workspaces.issueId, issueIds),
      ne(workspaces.status, "closed"),
    ));
}

export async function getSessionsForWorkspacesDesc(
  workspaceIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(desc(sessions.startedAt));
}
