import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import type { TestDb } from "./test-db.js";
import { buildProjectStatusRows, statusIdsByName } from "@agentic-kanban/shared/lib/project-statuses";

export interface SeededProject {
  projectId: string;
  statusIds: Record<string, string>;
}

/**
 * Seed a project with the PRODUCTION status topology (#563).
 *
 * It used to hand-roll its own six columns and omit "Backlog" entirely, so any tool
 * behaviour that depends on the Backlog column was untestable here.
 */
export async function seedProject(db: TestDb, name = "Test Project"): Promise<SeededProject> {
  const now = new Date().toISOString();
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId, name, repoPath: `/tmp/${name}`, repoName: name,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });

  const rows = buildProjectStatusRows(projectId, now);
  for (const row of rows) await db.insert(schema.projectStatuses).values(row);

  return { projectId, statusIds: statusIdsByName(rows) };
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
  opts: { title?: string; priority?: string; issueNumber?: number; description?: string } = {},
): Promise<{ id: string; issueNumber: number }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const issueNumber = opts.issueNumber ?? 1;
  await db.insert(schema.issues).values({
    id, issueNumber, title: opts.title ?? "Issue", priority: opts.priority ?? "medium",
    description: opts.description,
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { id, issueNumber };
}
