import { projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllProjects } from "./project.repository.js";

export async function getProjectHealthRows(database: Database = db) {
  const rows = await getAllProjects(database, { includeArchived: true });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    repoPath: p.repoPath,
    defaultBranch: p.defaultBranch,
  }));
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
