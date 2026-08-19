import { issues, workspaces, projectStatuses, workflowNodes, tags, issueTags, issueDependencies, issueArtifacts, agentSkills } from "@agentic-kanban/shared/schema";
import { loadIssueSummary, type IssueSummaryResult } from "@agentic-kanban/shared/lib/issue-summary";
import { parseIssueRef } from "@agentic-kanban/shared/lib/issue-ref";
import { eq, inArray, and, gte, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { ValidationError } from "../errors/index.js";
import { nextIssueNumber } from "./issue-number.repository.js";

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

export const DEFAULT_STATUSES = [
  { name: "Backlog", sortOrder: -1, isDefault: false },
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

export async function initializeProjectStatuses(
  projectId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  for (const status of DEFAULT_STATUSES) {
    await database.insert(projectStatuses).values({
      id: randomUUID(),
      projectId,
      name: status.name,
      sortOrder: status.sortOrder,
      isDefault: status.isDefault,
      createdAt: now,
    });
  }
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
    id: issues.id,
    issueNumber: issues.issueNumber,
    title: issues.title,
    description: issues.description,
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
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
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
    .limit(1);
  return rows[0] ?? null;
}

export async function getIssueProjectId(
  issueId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0]?.projectId ?? null;
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
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
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
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
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

/**
 * Issue rows projected for the Focus ranking ("what should I work on next?"):
 * status name + the current workflow node's type (so isTerminalStatusView can tell
 * done-ness), priority/estimate for scoring. One per-project read, no I/O beyond the DB.
 */
export async function getFocusIssueRows(projectId: string, database: Database = db) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      priority: issues.priority,
      issueType: issues.issueType,
      estimate: issues.estimate,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}

/** The cached touched-files prediction JSON for one issue, or null when the issue is absent. */
export async function getIssueTouchedFiles(
  issueId: string,
  database: Database = db,
): Promise<{ touchedFilesJson: string | null } | null> {
  const rows = await database
    .select({ touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

/** Touched-files JSON + projectId for one issue (related-issues lookup), or null when absent. */
export async function getIssueTouchedFilesWithProject(
  issueId: string,
  database: Database = db,
): Promise<{ touchedFilesJson: string | null; projectId: string } | null> {
  const rows = await database
    .select({ touchedFilesJson: issues.touchedFilesJson, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

/** All issues in a project with their touched-files JSON (related-issues file-overlap scan). */
export async function getProjectIssuesTouchedFiles(projectId: string, database: Database = db) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

/**
 * All issues in a project with status name + sort order + the create/move
 * timestamps, for the cumulative-flow and status-distribution charts. Pure read;
 * the route builds the day axis and per-status counts.
 */
export async function getIssueStatusTimelineRows(projectId: string, database: Database = db) {
  return database
    .select({
      issueId: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
      statusSortOrder: projectStatuses.sortOrder,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));
}

/**
 * Issues currently in "Done" whose statusChangedAt falls on/after `cutoffDay`,
 * with their create/move timestamps — backs the throughput and lead-time charts.
 */
export async function getDoneIssuesSince(projectId: string, cutoffDay: string, database: Database = db) {
  return database
    .select({
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(projectStatuses.name, "Done"),
        gte(issues.statusChangedAt, cutoffDay),
      ),
    );
}

/**
 * Issue rows for the standup digest: every issue in a project with its status
 * name, workflow node type, and the timestamps the digest windows on
 * (createdAt / statusChangedAt). Pure read; the route buckets these in JS.
 */
export async function getDigestIssueRows(projectId: string, database: Database = db) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      priority: issues.priority,
      issueType: issues.issueType,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}

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
      latestSymlinkState: workspaces.latestSymlinkState,
      latestSymlinkStartedAt: workspaces.latestSymlinkStartedAt,
      latestSymlinkEndedAt: workspaces.latestSymlinkEndedAt,
      latestSymlinkDirs: workspaces.latestSymlinkDirs,
      latestSymlinkLinked: workspaces.latestSymlinkLinked,
      latestSymlinkSkipped: workspaces.latestSymlinkSkipped,
      latestSymlinkFailed: workspaces.latestSymlinkFailed,
      latestSymlinkError: workspaces.latestSymlinkError,
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
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
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
  const rows = await database
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId)))
    .limit(1);
  return rows[0]?.id ?? null;
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
  const rows = await database.select({ id: issues.id }).from(issues).where(eq(issues.statusId, statusId)).limit(1);
  return rows[0]?.id ?? null;
}

/**
 * id + issueNumber + touchedFilesJson for a set of issue numbers in a project
 * (CLI `issue check-overlap`). The found-set + overlap-building stays in the CLI.
 */
export async function getIssuesTouchedFilesByNumbers(
  projectId: string,
  issueNumbers: number[],
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(and(inArray(issues.issueNumber, issueNumbers), eq(issues.projectId, projectId)));
}
