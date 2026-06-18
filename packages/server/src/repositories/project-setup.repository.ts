import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectRepoInfo(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ repoPath: projects.repoPath, repoName: projects.repoName })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProjectRepoInfoWithSetupScript(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ repoPath: projects.repoPath, repoName: projects.repoName, setupScript: projects.setupScript })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}
