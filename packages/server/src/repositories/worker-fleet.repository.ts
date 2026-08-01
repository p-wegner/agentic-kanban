import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface ProjectRepoFields {
  repoPath: string | null;
  defaultBranch: string | null;
  setupScript: string | null;
}

/** Project fields `resolveWorkerPlacement` needs to hand a remote worker git transport. */
export async function getProjectRepoFields(
  projectId: string,
  database: Database = db,
): Promise<ProjectRepoFields | null> {
  const rows = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch, setupScript: projects.setupScript })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}
