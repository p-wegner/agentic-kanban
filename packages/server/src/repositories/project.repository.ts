import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { deleteProjectCascade as deleteProjectCascadeShared } from "@agentic-kanban/shared/lib/cascade-delete";
import { eq, sql, and, isNull, isNotNull, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { initializeProjectStatuses } from "./issue.repository.js";

/**
 * Facade barrel (#889 god-module gate). The `project_statuses` lifecycle — list, create,
 * reorder, delete — is one cohesive responsibility and now lives in its own module; this file
 * kept growing past the 20-declaration cohesion ceiling otherwise. Re-exported here so every
 * existing `from "./project.repository.js"` importer is unaffected by the split.
 */
export {
  getProjectStatuses,
  createProjectStatus,
  updateProjectStatusSortOrder,
  deleteProjectStatus,
  getProjectStatusById,
  deleteProjectStatusById,
} from "./project-status.repository.js";

export async function getProjectById(
  projectId: string,
  database: Database = db,
) {
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Canonical repoPath accessor (#957). Was duplicated verbatim in
 * agent-skill/drive-service/issue-ai per-consumer mirror files — this is now the
 * only copy; services import it from here.
 */
export async function getProjectRepoPath(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const project = await getProjectById(projectId, database);
  return project?.repoPath ?? null;
}

/** Batch project lookup by ids (#957 — was merge-queue.repository's private mirror). */
export async function getProjectsByIds(
  projectIds: string[],
  database: Database = db,
) {
  if (projectIds.length === 0) return [];
  return database.select().from(projects).where(inArray(projects.id, projectIds));
}

export async function getProjectByRepoPath(
  repoPath: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.repoPath, repoPath))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Raw `servicesConfig` JSON for every project that has one set (#142 — narrow
 * accessor so `anyProjectHasEnabledServiceStack` in workspace-service-state.repository.ts
 * doesn't re-query `projects` directly).
 */
export async function getProjectsWithServicesConfig(
  database: Database = db,
): Promise<{ servicesConfig: string | null }[]> {
  return database
    .select({ servicesConfig: projects.servicesConfig })
    .from(projects)
    .where(isNotNull(projects.servicesConfig));
}

export async function getAllProjects(
  database: Database = db,
  opts: { includeArchived?: boolean } = {},
) {
  if (opts.includeArchived) {
    return database.select().from(projects);
  }
  return database.select().from(projects).where(isNull(projects.archivedAt));
}

/** `{id, name}` for every non-archived project — the cross-project inbox scan (#302) only needs these. */
export async function getActiveProjectSummaries(
  database: Database = db,
): Promise<Array<{ id: string; name: string }>> {
  return database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt));
}

export async function setProjectArchived(
  projectId: string,
  archived: boolean,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId));
}

export async function insertProject(
  id: string,
  values: {
    name: string;
    description?: string | null;
    color?: string | null;
    repoPath: string;
    repoName: string;
    defaultBranch: string | null;
    remoteUrl: string | null;
    defaultSkillId?: string | null;
  },
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database.insert(projects).values({
    id,
    name: values.name,
    description: values.description ?? null,
    color: values.color ?? null,
    repoPath: values.repoPath,
    repoName: values.repoName,
    defaultBranch: values.defaultBranch,
    remoteUrl: values.remoteUrl,
    defaultSkillId: values.defaultSkillId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await initializeProjectStatuses(id, now, database);
  return { id, name: values.name, repoPath: values.repoPath, defaultBranch: values.defaultBranch };
}

/**
 * Cascade-delete a project and everything referencing it. Thin caller — the walk
 * itself (table list, ordering, single-transaction atomicity, per-project
 * preference cleanup) lives in shared/lib/cascade-delete.ts, the single home for
 * all cascade knowledge (#949).
 */
export async function deleteProjectCascade(
  projectId: string,
  database: Database = db,
): Promise<void> {
  await deleteProjectCascadeShared(projectId, database);
}

/**
 * Persist a project's declared Docker service-stack config (JSON string) or clear it
 * (null). Kept out of the generic `updateProjectFields` mapper so the route can own
 * the servicesConfig validation + JSON serialization (mirrors setup-script handling).
 */
export async function updateProjectServicesConfig(
  projectId: string,
  servicesConfigJson: string | null,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ servicesConfig: servicesConfigJson, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId));
}

export async function getProjectStats(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ statusName: projectStatuses.name, count: sql<number>`count(*)` })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .groupBy(projectStatuses.name);
}

/**
 * Rows backing the per-provider throughput digest: Done issues (moved to Done
 * within the window) joined to their merged workspace's provider attribution.
 * Pure read — the route owns the dedup/percentile aggregation over these rows.
 */
export async function getDoneIssueProviderAttribution(
  projectId: string,
  cutoffDay: string,
  database: Database = db,
) {
  return database
    .select({
      issueId: issues.id,
      issueCreatedAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
      mergedAt: workspaces.mergedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(workspaces, eq(issues.id, workspaces.issueId))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(projectStatuses.name, "Done"),
        gte(issues.statusChangedAt, cutoffDay),
      ),
    );
}

/** A project by its exact name (first match), or null. */
export async function getProjectByName(name: string, database: Database = db) {
  const rows = await database.select().from(projects).where(eq(projects.name, name)).limit(1);
  return rows[0] ?? null;
}

/**
 * The two project fields the workspace-repo-status batch needs for its leading-repo fallback.
 *
 * Lives here, not beside its caller: `repository-table-ownership` (#957) keeps `projects` reads
 * in this file so the aggregate has one reader. It was previously a direct `select().from(projects)`
 * in workspace-repo-status-batch.repository.ts, which is the drift that guard exists to catch.
 */
export async function getProjectRepoFields(
  projectId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string | null } | undefined> {
  const [project] = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project;
}
