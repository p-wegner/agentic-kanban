import { issues, workspaces, sessions, sessionMessages, projectStatuses, workflowNodes, tags, issueTags, issueDependencies, issueArtifacts, agentSkills } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { eq, inArray, desc, sql, and, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { ValidationError } from "../errors/index.js";
import { getSessionMessageRows } from "./session.repository.js";
import { parseStatsBlob, projectSessionStats, computeSessionDuration } from "../lib/issue-summary-projection.js";

type Issue = typeof issues.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type Session = typeof sessions.$inferSelect;

export interface IssueSummaryResult {
  issueId: string;
  issueNumber: number | null;
  title: string;
  workspace: { id: string; branch: string | null; status: string } | null;
  session: { id: string; status: string; startedAt: string | null; endedAt: string | null; duration: string | null } | null;
  stats: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    model: string | null;
    success: boolean;
  } | null;
  agentSummary: string | null;
  filesEdited: string[];
  filesRead: string[];
  commandsRun: string[];
  errors: string[];
  model: string | null;
  status?: string;
  summary?: null;
}

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
  const [maxResult, statusRows] = await Promise.all([
    database
      .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
      .from(issues)
      .where(eq(issues.projectId, projectId)),
    providedStatusId
      ? Promise.resolve(null)
      : database
          .select({ id: projectStatuses.id })
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, projectId))
          .limit(1),
  ]);

  const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

  if (providedStatusId) {
    return { issueNumber, statusId: providedStatusId };
  }

  if (!statusRows || statusRows.length === 0) {
    throw new ValidationError("No statuses found for project");
  }

  return { issueNumber, statusId: statusRows[0].id };
}

export async function getIssueSummary(
  idParam: string,
  database: Database = db,
): Promise<IssueSummaryResult | null> {
  const isNumeric = /^\d+$/.test(idParam);
  const issueRows = isNumeric
    ? await database.select().from(issues).where(eq(issues.issueNumber, Number(idParam))).limit(1)
    : await database.select().from(issues).where(eq(issues.id, idParam)).limit(1);

  if (issueRows.length === 0) return null;

  const issue = issueRows[0];

  const wsRows = await database.select().from(workspaces).where(eq(workspaces.issueId, issue.id));

  if (wsRows.length === 0) {
    return { issueId: issue.id, issueNumber: issue.issueNumber, title: issue.title, status: "no workspace", summary: null, workspace: null, session: null, stats: null, agentSummary: null, filesEdited: [], filesRead: [], commandsRun: [], errors: [], model: null };
  }

  const wsIds = wsRows.map(w => w.id);
  const sessionRows = await database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));

  const completedSession = sessionRows.find(s => s.status === "completed" || s.status === "stopped")
    ?? sessionRows[0]
    ?? null;

  if (!completedSession) {
    return { issueId: issue.id, issueNumber: issue.issueNumber, title: issue.title, status: "no session", summary: null, workspace: null, session: null, stats: null, agentSummary: null, filesEdited: [], filesRead: [], commandsRun: [], errors: [], model: null };
  }

  const msgRows = await getSessionMessageRows(completedSession.id, database);

  const parsedStats = parseStatsBlob(completedSession.stats);
  const duration = computeSessionDuration(completedSession.startedAt, completedSession.endedAt);

  const summary = parseSessionSummary(msgRows);
  if (!summary.agentSummary && parsedStats && typeof parsedStats.agentSummary === "string") {
    summary.agentSummary = parsedStats.agentSummary;
  }

  const matchingWorkspace = wsRows.find(w => w.id === completedSession.workspaceId);

  return {
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    workspace: matchingWorkspace ? { id: matchingWorkspace.id, branch: matchingWorkspace.branch, status: matchingWorkspace.status } : null,
    session: { id: completedSession.id, status: completedSession.status, startedAt: completedSession.startedAt, endedAt: completedSession.endedAt, duration },
    stats: projectSessionStats(parsedStats, summary.model),
    ...summary,
  };
}

export async function getIssuesByProject(
  projectId: string,
  issueNumber?: number,
  database: Database = db,
  statusName?: string,
  opts?: { excludeDescription?: boolean },
) {
  const conditions = [eq(issues.projectId, projectId)];
  if (issueNumber !== undefined) conditions.push(eq(issues.issueNumber, issueNumber));
  if (statusName !== undefined) conditions.push(eq(projectStatuses.name, statusName));
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

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
    return database
      .select(slimSelection)
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(whereClause)
      .orderBy(issues.sortOrder);
  }

  return database
    .select(fullSelection)
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause)
    .orderBy(issues.sortOrder);
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
