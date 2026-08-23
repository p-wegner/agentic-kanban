import { issues, workspaces, projectStatuses, tags, issueTags, issueDependencies, issueArtifacts, agentSkills, workspaceSymlinkRun } from "@agentic-kanban/shared/schema";
import { loadIssueSummary, type IssueSummaryResult } from "@agentic-kanban/shared/lib/issue-summary";
import { parseIssueRef } from "@agentic-kanban/shared/lib/issue-ref";
import { DEFAULT_PROJECT_STATUSES, buildProjectStatusRows, statusIdsByName } from "@agentic-kanban/shared/lib/project-statuses";
import { eq, inArray, and, count, asc, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { ValidationError } from "../errors/index.js";
import { nextIssueNumber } from "./issue-number.repository.js";
import { issueDependencyColumns, issueTextColumns, projectStatusIdName } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";
import { firstRow } from "../lib/first-row.js";

// --- CLI-command-specific queries/mutations (#465 decomposition — the blanket
// /repositories/ cohesion exemption was removed by #957, so this facade ships its
// own sub-module instead of growing past the flat threshold). Public surface
// preserved byte-identical for existing importers (cli/commands/*, tests). ---
export {
  getIssueListForProject,
  getIssueHeaderByNumber,
  getIssueByNumberOrId,
  getIssueWithStatusById,
  getIssueTitleDescriptionByNumber,
  createIssueWithNextNumber,
  moveIssueToStatus,
  createSubIssueWithParentLink,
} from "./issue/cli-commands.repository.js";

// The wire shape moved to `shared/lib/issue-summary.ts` with the loader (#506); re-exported
// here so the existing importers (issue.service, routes, tests) are unchanged.
export type { IssueSummaryResult };

/**
 * The default status topology now lives in `@agentic-kanban/shared/lib/project-statuses`
 * so the test helpers can seed exactly what production creates (#563). Re-exported here
 * because the CLI's `register`/`create` commands print it from this module.
 */
export const DEFAULT_STATUSES = DEFAULT_PROJECT_STATUSES;

/**
 * Seed a new project's status columns and RETURN their ids by name (#563).
 *
 * It used to return `void`, which is why no caller could hand ids on and 137 test files
 * grew their own hand-rolled (and drifted) seeders instead.
 */
export async function initializeProjectStatuses(
  projectId: string,
  now: string,
  database: Database = db,
): Promise<Record<string, string>> {
  // #668 — this used to insert the canonical set unconditionally, so calling it twice for one
  // project produced a SECOND set: two columns named "Todo", one holding every issue and one
  // permanently empty, with every by-name lookup silently picking whichever came first. It is
  // the only unguarded seeding path (`project-registration.ts:528` already checks, and
  // `deduplicateProjects` matches by name), and since 0125 a duplicate is a constraint
  // violation rather than a quiet second column — so the guard is what keeps a legitimate
  // double call working instead of throwing.
  //
  // Insert only the names the project does not already have, and return ids for ALL of them:
  // the caller wants the project's status map, not a record of what this call happened to write.
  // Order-INDEPENDENT (#773): only a Set of names and an id-by-name record are built from
  // this. (The load-bearing "first status" read lives in `resolveNewIssueDefaults` below,
  // which carries its own explicit ORDER BY.)
  const existing = await listProjectStatusIdNames(projectId, database);
  const existingNames = new Set(existing.map((row) => row.name));

  const rows = buildProjectStatusRows(projectId, now).filter((row) => !existingNames.has(row.name));
  for (const row of rows) {
    await database.insert(projectStatuses).values(row);
  }
  return { ...statusIdsByName(existing), ...statusIdsByName(rows) };
}

/**
 * Returns the next issue number for the project and the default statusId.
 * Throws if no statuses are configured for the project.
 */
export async function resolveNewIssueDefaults(
  projectId: string,
  providedStatusId: string | undefined,
  database: Database = db,
): Promise<{ issueNumber: number; statusId: string }> {
  const [issueNumber, statusRows] = await Promise.all([
    nextIssueNumber(projectId, database),
    providedStatusId
      ? Promise.resolve(null)
      : database
          .select({ id: projectStatuses.id })
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, projectId))
          // ORDER BY, because `limit(1)` without one returns whatever the query plan
          // happens to yield first — and the plan is not stable. This read had no order at
          // all, so "the status a new issue lands in" was decided by which index SQLite
          // chose; adding the #668 unique index on (project_id, name) silently moved it
          // from insertion order to NAME order, i.e. a new issue started landing in "AI
          // Reviewed" instead of "Todo". The column is not arbitrary — `is_default` exists
          // to name it, and `sort_order` breaks the tie leftmost-first.
          .orderBy(desc(projectStatuses.isDefault), asc(projectStatuses.sortOrder))
          .limit(1),
  ]);

  if (providedStatusId) {
    return { issueNumber, statusId: providedStatusId };
  }

  if (!statusRows || statusRows.length === 0) {
    throw new ValidationError("No statuses found for project");
  }

  return { issueNumber, statusId: statusRows[0].id };
}

/**
 * REST's entry into the shared loader (#506). The six-step chain, the session-selection
 * policy, and the project scoping all live in `shared/lib/issue-summary.ts` now — this
 * only decides how the caller's `idParam` string maps onto a `IssueSummaryRef`.
 */
export async function getIssueSummary(
  idParam: string,
  database: Database = db,
  /**
   * Scope for a NUMERIC `idParam` (#506). Issue numbers are per-project
   * (`MAX(issue_number) + 1`), so an unscoped `where(issueNumber = N)` matches a row in
   * every project that has reached N and `.limit(1)` picks an arbitrary one. Verified live
   * on a 25-project board: `GET /api/issues/5/summary` returned a fixture project's issue,
   * not the active project's. Ignored for a UUID, which is already unambiguous.
   */
  projectId?: string,
): Promise<IssueSummaryResult | null> {
  const parsed = parseIssueRef(idParam);
  return loadIssueSummary(
    database,
    parsed.kind === "number" ? { issueNumber: parsed.issueNumber, projectId } : { issueId: parsed.issueId },
  );
}

export async function getIssuesByProject(
  projectId: string,
  issueNumber?: number,
  database: Database = db,
  statusName?: string,
  opts?: { excludeDescription?: boolean; limit?: number; offset?: number },
) {
  const conditions = [eq(issues.projectId, projectId)];
  if (issueNumber !== undefined) conditions.push(eq(issues.issueNumber, issueNumber));
  if (statusName !== undefined) conditions.push(eq(projectStatuses.name, statusName));
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  // Pagination (#424). The list is unbounded — it grows with every issue a project ever
  // had (380 done on the dev board at the time of writing) and every consumer paid the
  // whole thing. `limit` is opt-in so the default response shape is unchanged; `offset`
  // without `limit` is meaningless in SQLite and is therefore ignored rather than
  // silently returning an empty page.
  const hasLimit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0;
  const offset = typeof opts?.offset === "number" && Number.isFinite(opts.offset) && opts.offset > 0
    ? Math.floor(opts.offset)
    : 0;

  const fullSelection = {
    ...issueTextColumns,
    priority: issues.priority,
    issueType: issues.issueType,
    sortOrder: issues.sortOrder,
    statusId: issues.statusId,
    projectId: issues.projectId,
    createdAt: issues.createdAt,
    updatedAt: issues.updatedAt,
    statusChangedAt: issues.statusChangedAt,
    skipAutoReview: issues.skipAutoReview,
    estimate: issues.estimate,
    dueDate: issues.dueDate,
    externalKey: issues.externalKey,
    externalUrl: issues.externalUrl,
    pinned: issues.pinned,
    milestoneId: issues.milestoneId,
    statusName: projectStatuses.name,
  };

  if (opts?.excludeDescription) {
    // Slim variant (?slim=1) for list consumers that never render descriptions —
    // description is ~60% of a full-project payload. The key is absent
    // (undefined), not null, in slim rows.
    const { description: _description, ...slimSelection } = fullSelection;
    const q = database
      .select(slimSelection)
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(whereClause)
      .orderBy(issues.sortOrder);
    return hasLimit ? q.limit(Math.floor(opts!.limit!)).offset(offset) : q;
  }

  const q = database
    .select(fullSelection)
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause)
    .orderBy(issues.sortOrder);
  return hasLimit ? q.limit(Math.floor(opts!.limit!)).offset(offset) : q;
}

/**
 * Total issues matching the same filters, ignoring limit/offset — so a paginated
 * caller can report "showing 50 of 380" without fetching all 380 (#424).
 */
export async function countIssuesByProject(
  projectId: string,
  database: Database = db,
  statusName?: string,
) {
  const conditions = [eq(issues.projectId, projectId)];
  if (statusName !== undefined) conditions.push(eq(projectStatuses.name, statusName));
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const rows = await database
    .select({ n: count() })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause);
  return Number(rows[0]?.n ?? 0);
}

export async function getIssueDescription(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({
        ...issueTextColumns,
        priority: issues.priority,
        issueType: issues.issueType,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
        dueDate: issues.dueDate,
        externalKey: issues.externalKey,
        externalUrl: issues.externalUrl,
        pinned: issues.pinned,
        milestoneId: issues.milestoneId,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

export async function getIssueProjectId(
  issueId: string,
  database: Database = db,
): Promise<string | null> {
  return (await firstRow(
    database
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  ))?.projectId ?? null;
}

export async function getIssueTags(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(eq(issueTags.issueId, issueId));
}

export async function getOutgoingDependencies(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      ...issueDependencyColumns,
      createdAt: issueDependencies.createdAt,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      issueNumber: issues.issueNumber,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.dependsOnId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issueDependencies.issueId, issueId));
}

export async function getIncomingDependencies(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      ...issueDependencyColumns,
      createdAt: issueDependencies.createdAt,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      issueNumber: issues.issueNumber,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issueDependencies.dependsOnId, issueId));
}

// --- Reporting read models (#728). Four whole-project projections backing Focus, the
// cumulative-flow/throughput charts and the standup digest — extracted because their
// consumers (focus.service, issue-analytics, digest.service) are disjoint from every
// other reader in this file. Re-exported so no call site changed. ---
export {
  getFocusIssueRows,
  getIssueStatusTimelineRows,
  getDoneIssuesSince,
  getDigestIssueRows,
} from "./issue/analytics.repository.js";

// --- The touched-files read model (#728): four scopes over the `touched_files_json`
// prediction CACHE, which every reader must treat as possibly-absent. Re-exported so
// routes/issues.ts and the CLI's check-overlap keep the same import specifier. ---
export {
  getIssueTouchedFiles,
  getIssueTouchedFilesWithProject,
  getProjectIssuesTouchedFiles,
  getIssuesTouchedFilesByNumbers,
} from "./issue/touched-files.repository.js";


/** All dependency edges whose dependent (issueId) is in the given set — for graph building. */
export async function getDependenciesForIssues(issueIds: string[], database: Database = db) {
  if (issueIds.length === 0) return [];
  return database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(inArray(issueDependencies.issueId, issueIds));
}

export async function getIssueWorkspaces(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      planMode: workspaces.planMode,
      includeVisualProof: workspaces.includeVisualProof,
      requiresReview: workspaces.requiresReview,
      thoroughReview: workspaces.thoroughReview,
      readyForMerge: workspaces.readyForMerge,
      status: workspaces.status,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      skillId: workspaces.skillId,
      skillName: agentSkills.name,
      contextPrimer: workspaces.contextPrimer,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      latestSetupCommand: workspaces.latestSetupCommand,
      latestSetupState: workspaces.latestSetupState,
      latestSetupStartedAt: workspaces.latestSetupStartedAt,
      latestSetupEndedAt: workspaces.latestSetupEndedAt,
      latestSetupExitCode: workspaces.latestSetupExitCode,
      latestSetupDurationMs: workspaces.latestSetupDurationMs,
      latestSetupStdoutTail: workspaces.latestSetupStdoutTail,
      latestSetupStderrTail: workspaces.latestSetupStderrTail,
      // #798: the symlink run moved to `workspace_symlink_run`. Aliased back to the same
      // eight field names, so the projection and the DTO it builds are untouched.
      latestSymlinkState: workspaceSymlinkRun.state,
      latestSymlinkStartedAt: workspaceSymlinkRun.startedAt,
      latestSymlinkEndedAt: workspaceSymlinkRun.endedAt,
      latestSymlinkDirs: workspaceSymlinkRun.dirs,
      latestSymlinkLinked: workspaceSymlinkRun.linked,
      latestSymlinkSkipped: workspaceSymlinkRun.skipped,
      latestSymlinkFailed: workspaceSymlinkRun.failed,
      latestSymlinkError: workspaceSymlinkRun.error,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      scorecardScore: workspaces.scorecardScore,
      serviceState: workspaces.serviceState,
    })
    .from(workspaces)
    .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
    .leftJoin(workspaceSymlinkRun, eq(workspaceSymlinkRun.workspaceId, workspaces.id))
    .where(eq(workspaces.issueId, issueId));
}

export async function getIssueArtifacts(
  issueId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(issueArtifacts)
    .where(eq(issueArtifacts.issueId, issueId))
    .orderBy(issueArtifacts.createdAt);
}

export async function assignTag(
  issueId: string,
  tagId: string,
  database: Database = db,
) {
  const id = randomUUID();
  await database.insert(issueTags).values({ id, issueId, tagId });
  return { id };
}

export async function removeTag(
  issueId: string,
  tagId: string,
  database: Database = db,
) {
  await database.delete(issueTags)
    .where(and(eq(issueTags.issueId, issueId), eq(issueTags.tagId, tagId)));
}

export async function deleteArtifact(
  issueId: string,
  artifactId: string,
  database: Database = db,
) {
  await database.delete(issueArtifacts)
    .where(and(eq(issueArtifacts.id, artifactId), eq(issueArtifacts.issueId, issueId)));
}

/** All issues of a project + their status name, ordered by issue number — for export. */
export async function getIssuesForExport(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueTextColumns,
      priority: issues.priority,
      issueType: issues.issueType,
      estimate: issues.estimate,
      statusName: projectStatuses.name,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.issueNumber);
}

/** Tag names for a batch of issues (issue_tags ⋈ tags). Empty input → empty result. */
export async function getTagsForIssues(issueIds: string[], database: Database = db) {
  if (issueIds.length === 0) return [];
  return database
    .select({ issueId: issueTags.issueId, tagName: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));
}

/** Resolve an issue id by its per-project issue number (scoped to the project). */
export async function getIssueIdByNumberInProject(
  issueNumber: number,
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  return (await firstRow(
    database
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId)))
      .limit(1)
  ))?.id ?? null;
}

/** {statusId, statusName} for every issue in a project (board status-count source). */
export async function getIssueStatusNameRowsForProject(projectId: string, database: Database = db) {
  return database
    .select({ statusId: issues.statusId, statusName: projectStatuses.name })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));
}

/** The first issue id linked to a status (used to block status deletion), or null. */
export async function getFirstIssueIdWithStatus(statusId: string, database: Database = db): Promise<string | null> {
  return (await firstRow(
    database.select({ id: issues.id }).from(issues).where(eq(issues.statusId, statusId)).limit(1),
  ))?.id ?? null;
}
