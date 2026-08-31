/**
 * Reads and writes for relocating a project's checkout (#964).
 *
 * The `projects` half lives in `project.repository.ts` (the table's owner, per the
 * repository-table-ownership ratchet); this module owns the OTHER tables a relocation
 * has to rewrite — `repos`, `workspaces` and the `projects_base_path` preference — so
 * the set of path-bearing columns is enumerated in exactly one place. When a new column
 * starts holding an absolute path, adding it here is what makes relocation see it.
 */
import { eq } from "drizzle-orm";
import { issues, preferences, repos, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

/** The preference holding the parent directory new projects are scaffolded into. */
export const PROJECTS_BASE_PATH_KEY = "projects_base_path";

/** Every workspace of `projectId`, with the columns a relocation reads or rewrites. */
export async function getProjectWorkspacePaths(projectId: string, database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      status: workspaces.status,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}

/** Project-scoped sibling-repo rows (`projectId` set, no workspace). */
export async function getProjectScopedRepoPaths(projectId: string, database: Database = db) {
  return database
    .select({ id: repos.id, path: repos.path, worktreePath: repos.worktreePath })
    .from(repos)
    .where(eq(repos.projectId, projectId));
}

/** Workspace-scoped repo rows for ONE workspace (leading mirror row + siblings). */
export async function getWorkspaceScopedRepoPaths(workspaceId: string, database: Database = db) {
  return database
    .select({ id: repos.id, path: repos.path, worktreePath: repos.worktreePath })
    .from(repos)
    .where(eq(repos.workspaceId, workspaceId));
}

export async function updateWorkspaceWorkingDir(
  workspaceId: string,
  workingDir: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.update(workspaces).set({ workingDir }).where(eq(workspaces.id, workspaceId));
}

export async function updateRepoPaths(
  repoId: string,
  fields: { path?: string; worktreePath?: string },
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.update(repos).set(fields).where(eq(repos.id, repoId));
}

export async function updatePreferenceValue(
  key: string,
  value: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.update(preferences).set({ value }).where(eq(preferences.key, key));
}

/** The raw `projects_base_path` value, or null when unset. */
export async function getProjectsBasePathPreference(database: Database = db): Promise<string | null> {
  const row = await firstRow(
    database
      .select({ value: preferences.value })
      .from(preferences)
      .where(eq(preferences.key, PROJECTS_BASE_PATH_KEY))
      .limit(1),
  );
  return row?.value ?? null;
}
