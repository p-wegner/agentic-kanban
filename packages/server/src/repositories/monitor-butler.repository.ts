import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectSummaryById(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projects.id, name: projects.name, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
}
