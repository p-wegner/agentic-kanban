import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectRepoInfo(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { repoPath: project.repoPath, repoName: project.repoName } : null;
}

export async function getProjectRepoInfoWithSetupScript(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { repoPath: project.repoPath, repoName: project.repoName, setupScript: project.setupScript } : null;
}
