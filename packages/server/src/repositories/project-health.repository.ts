import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectHealthRows(database: Database = db) {
  return database.select({
    id: projects.id,
    name: projects.name,
    color: projects.color,
    repoPath: projects.repoPath,
    defaultBranch: projects.defaultBranch,
  }).from(projects);
}

export async function getIssueCountsByStatus(database: Database = db) {
  return database
    .select({
      projectId: issues.projectId,
      statusName: projectStatuses.name,
      count: sql<number>`count(*)`,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .groupBy(issues.projectId, projectStatuses.name);
}
