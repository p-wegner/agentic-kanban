import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectRepoPath(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const project = await getProjectById(projectId, database);
  return project?.repoPath ?? null;
}
