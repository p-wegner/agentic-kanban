import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import type { TestDb } from "./test-db.js";

export interface SeededProject {
  projectId: string;
  statusIds: Record<string, string>;
}

/** Seed a project with Todo / In Progress / Done / AI Reviewed statuses. */
export async function seedProject(db: TestDb, name = "Test Project"): Promise<SeededProject> {
  const now = new Date().toISOString();
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId, name, repoPath: `/tmp/${name}`, repoName: name,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });

  const names = ["Todo", "In Progress", "Done", "AI Reviewed"];
  const statusIds: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    const id = randomUUID();
    statusIds[names[i]] = id;
    await db.insert(schema.projectStatuses).values({
      id, projectId, name: names[i], sortOrder: i, isDefault: i === 0, createdAt: now,
    });
  }

  return { projectId, statusIds };
}

/** Set the active project preference so tools that default to it resolve correctly. */
export async function setActiveProject(db: TestDb, projectId: string): Promise<void> {
  await db.insert(schema.preferences).values({
    key: "activeProjectId", value: projectId, updatedAt: new Date().toISOString(),
  });
}

/** Insert an issue and return its id + number. */
export async function seedIssue(
  db: TestDb,
  projectId: string,
  statusId: string,
  opts: { title?: string; priority?: string; issueNumber?: number } = {},
): Promise<{ id: string; issueNumber: number }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const issueNumber = opts.issueNumber ?? 1;
  await db.insert(schema.issues).values({
    id, issueNumber, title: opts.title ?? "Issue", priority: opts.priority ?? "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { id, issueNumber };
}
