import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectRepoPath(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.repoPath ?? null;
}
