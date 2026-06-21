import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectSummaryById(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? [{ id: project.id, name: project.name, repoPath: project.repoPath }] : [];
}
