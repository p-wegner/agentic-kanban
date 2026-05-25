import { db } from "../db/index.js";
import { projects, projectStatuses, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "./git-info.service.js";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

export async function registerProject(path: string, options?: { name?: string }) {
  const repoInfo = await detectRepoInfo(path);
  const projectName = options?.name || repoInfo.repoName;

  const existing = await db
    .select()
    .from(projects)
    .where(eq(projects.repoPath, repoInfo.repoPath))
    .limit(1);

  if (existing.length > 0) {
    return { project: existing[0], created: false };
  }

  const now = new Date().toISOString();
  const projectId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch: repoInfo.defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    createdAt: now,
    updatedAt: now,
  });

  for (const status of DEFAULT_STATUSES) {
    await db.insert(projectStatuses).values({
      id: randomUUID(),
      projectId,
      name: status.name,
      sortOrder: status.sortOrder,
      isDefault: status.isDefault,
      createdAt: now,
    });
  }

  await db
    .insert(preferences)
    .values({
      key: "activeProjectId",
      value: projectId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: preferences.key,
      set: { value: projectId, updatedAt: now },
    });

  const project = {
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch: repoInfo.defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    createdAt: now,
    updatedAt: now,
  };

  return { project, created: true };
}
