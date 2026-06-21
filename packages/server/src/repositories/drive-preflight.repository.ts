import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectRepoAndBranch(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? [{ repoPath: project.repoPath, defaultBranch: project.defaultBranch }] : [];
}
