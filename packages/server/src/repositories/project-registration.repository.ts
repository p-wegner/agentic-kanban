import { projects, projectStatuses, preferences, issues, agentSkills } from "@agentic-kanban/shared/schema";
import * as schema from "@agentic-kanban/shared/schema";
import { expectedForeignKeyActions } from "@agentic-kanban/shared/lib/fk-actions";
import { eq, and, sql, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

type DbOrTx = Database | TransactionClient;

export async function getAllProjects(database: Database = db) {
  return database.select().from(projects);
}

export async function getProjectByIdRaw(
  projectId: string,
  database: Database = db,
) {
  return getProjectById(projectId, database);
}

export async function getProjectStatusesByProject(
  projectId: string,
  database: DbOrTx,
) {
  return database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
}

export async function remapIssueStatus(
  dupProjectId: string,
  dupStatusId: string,
  matchStatusId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(issues)
    .set({ statusId: matchStatusId })
    .where(and(eq(issues.projectId, dupProjectId), eq(issues.statusId, dupStatusId)));
}

/**
 * DB-table-name → Drizzle table object, built from the schema module. Lets the
 * generic reassignment below address an arbitrary table discovered via the FK graph.
 */
function tablesByDbName(): Map<string, SQLiteTable> {
  const map = new Map<string, SQLiteTable>();
  for (const value of Object.values(schema)) {
    if (is(value, SQLiteTable)) map.set(getTableConfig(value).name, value);
  }
  return map;
}

/** A direct FK edge from a child table's column to `projects.id`. */
export interface ProjectChildEdge {
  /** Child table DB-name. */
  table: string;
  /** Child column DB-name that references projects.id. */
  column: string;
}

/**
 * Every table column with a direct FK to `projects.id`, derived from the Drizzle
 * schema FK graph (NOT a hand-maintained list). A newly-added project-child table is
 * therefore reassigned by {@link reassignProjectChildren} automatically — the same
 * "derive from the schema" approach used for the issue deletion cascade (#929).
 */
export function projectChildEdges(): ProjectChildEdge[] {
  const edges: ProjectChildEdge[] = [];
  for (const [table, specs] of expectedForeignKeyActions()) {
    for (const spec of specs) {
      if (spec.refTable !== "projects") continue;
      for (const column of spec.columns) edges.push({ table, column });
    }
  }
  return edges;
}

/**
 * Reassign EVERY direct project-child row from one project to another, for every table
 * the schema FK graph says references `projects.id`, except those in `exclude`. This is
 * what makes project dedup lossless: cascade children (milestones/drives/drive_obstacles)
 * are no longer silently deleted with the duplicate project, and non-cascade children
 * (workflow_templates/quality_metrics/board_health_events/flaky_tests/
 * project_script_shortcuts/scheduled_run_history) are no longer orphaned or made to abort
 * the merge — they all follow the survivor.
 *
 * Uses parameterised raw SQL (safe identifiers via `sql.identifier`) so it is fully
 * generic over the discovered (table, column) edges. Returns the tables actually touched.
 *
 * `exclude` is for tables whose reassignment is handled specially by the caller:
 *   - `project_statuses` — the duplicate's statuses are remapped-by-name then DELETED,
 *     not moved (moving them would create duplicate-named status columns on the survivor).
 */
export async function reassignProjectChildren(
  fromProjectId: string,
  toProjectId: string,
  database: DbOrTx,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const byName = tablesByDbName();
  const touched: string[] = [];
  for (const edge of projectChildEdges()) {
    if (exclude.has(edge.table)) continue;
    if (!byName.has(edge.table)) continue; // schema table not migrated — skip defensively
    await database.run(
      sql`UPDATE ${sql.identifier(edge.table)} SET ${sql.identifier(edge.column)} = ${toProjectId} WHERE ${sql.identifier(edge.column)} = ${fromProjectId}`,
    );
    touched.push(edge.table);
  }
  return touched;
}

export async function insertProjectStatus(
  values: {
    id: string;
    projectId: string;
    name: string;
    sortOrder: number;
    isDefault: boolean;
    createdAt: string;
  },
  database: DbOrTx,
): Promise<void> {
  await database.insert(projectStatuses).values(values);
}

export async function deleteProjectStatusesByProject(
  projectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
}

export async function deleteProjectRow(
  projectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.delete(projects).where(eq(projects.id, projectId));
}

export async function getActiveProjectPreference(
  database: DbOrTx,
) {
  return database
    .select()
    .from(preferences)
    .where(eq(preferences.key, "activeProjectId"))
    .limit(1);
}

export async function setActiveProjectPreference(
  projectId: string,
  now: string,
  database: DbOrTx,
): Promise<void> {
  await database
    .insert(preferences)
    .values({ key: "activeProjectId", value: projectId, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: projectId, updatedAt: now } });
}

export async function updateProjectRepoPath(
  projectId: string,
  repoPath: string,
  repoName: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ repoPath, repoName, updatedAt: now })
    .where(eq(projects.id, projectId));
}

export async function getBoardNavigatorSkillId(
  database: Database = db,
): Promise<{ id: string } | undefined> {
  const [navSkill] = await database.select({ id: agentSkills.id }).from(agentSkills)
    .where(eq(agentSkills.name, "board-navigator")).limit(1);
  return navSkill;
}

export async function insertRegisteredProject(
  values: {
    id: string;
    name: string;
    repoPath: string;
    repoName: string;
    defaultBranch: string | null;
    remoteUrl: string | null;
    defaultSkillId: string | null;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(projects).values(values);
}

export async function upsertActiveProjectPreference(
  projectId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
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
}

export async function getProjectStatusIdsByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .limit(1);
}

export async function updateProjectDefaultBranch(
  projectId: string,
  branch: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ defaultBranch: branch, updatedAt: now })
    .where(eq(projects.id, projectId));
}
