import { projectScriptShortcuts, projects } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectForScripts(
  projectId: string,
  database: Database = db,
) {
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

export async function listProjectScriptShortcuts(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectScriptShortcuts)
    .where(eq(projectScriptShortcuts.projectId, projectId))
    .orderBy(projectScriptShortcuts.sortOrder, projectScriptShortcuts.createdAt);
}

export async function findProjectScriptShortcutByName(
  projectId: string,
  name: string,
  database: Database = db,
) {
  return database
    .select({ id: projectScriptShortcuts.id })
    .from(projectScriptShortcuts)
    .where(and(eq(projectScriptShortcuts.projectId, projectId), eq(projectScriptShortcuts.name, name)))
    .limit(1);
}

export async function insertProjectScriptShortcut(
  values: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    command: string;
    cwdMode: string;
    workingDir: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
) {
  await database.insert(projectScriptShortcuts).values(values);
}

export async function getProjectScriptShortcutById(
  shortcutId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectScriptShortcuts)
    .where(eq(projectScriptShortcuts.id, shortcutId))
    .limit(1);
}

export async function getProjectScriptShortcutForProject(
  shortcutId: string,
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectScriptShortcuts)
    .where(and(eq(projectScriptShortcuts.id, shortcutId), eq(projectScriptShortcuts.projectId, projectId)))
    .limit(1);
}

export async function getProjectScriptShortcutIdForProject(
  shortcutId: string,
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectScriptShortcuts.id })
    .from(projectScriptShortcuts)
    .where(and(eq(projectScriptShortcuts.id, shortcutId), eq(projectScriptShortcuts.projectId, projectId)))
    .limit(1);
}

export async function updateProjectScriptShortcut(
  shortcutId: string,
  updates: Record<string, unknown>,
  database: Database = db,
) {
  await database.update(projectScriptShortcuts).set(updates).where(eq(projectScriptShortcuts.id, shortcutId));
}

export async function deleteProjectScriptShortcut(
  shortcutId: string,
  database: Database = db,
) {
  await database.delete(projectScriptShortcuts).where(eq(projectScriptShortcuts.id, shortcutId));
}
