import { agentSkills, issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { eq, max } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getScheduledRunSystemIssueSummary(
  systemIssueId: string,
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title })
    .from(issues)
    .where(eq(issues.id, systemIssueId))
    .limit(1);
}

export async function getScheduledRunWorkspaceSummary(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id, branch: workspaces.branch, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function getScheduledRunSkill(
  skillId: string,
  database: Database = db,
) {
  return database
    .select({ prompt: agentSkills.prompt, name: agentSkills.name })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1);
}

export async function getScheduledRunProjectId(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? [{ id: project.id }] : [];
}

export async function getScheduledRunIssueId(
  issueId: string,
  database: Database = db,
) {
  return database.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function getProjectStatusesForScheduledRun(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

export async function getMaxIssueNumberForProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ maxNum: max(issues.issueNumber) })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

export async function insertScheduledRunSystemIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string;
    priority: string;
    statusId: string;
    projectId: string;
    skipAutoReview: boolean;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issues).values(values);
}
