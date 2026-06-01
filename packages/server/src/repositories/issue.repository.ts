import { issues, workspaces, sessions, sessionMessages, projectStatuses, tags, issueTags, issueDependencies, issueArtifacts, agentSkills } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";
import { eq, inArray, desc, sql, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

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

const DEFAULT_STATUSES = [
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
    const err = new Error("No statuses found for project") as any;
    err.statusCode = 400;
    throw err;
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

  const msgRows = await database
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, completedSession.id))
    .orderBy(sessionMessages.id);

  let parsedStats: Record<string, unknown> | null = null;
  if (completedSession.stats) {
    try { parsedStats = JSON.parse(completedSession.stats); } catch { /* ignore */ }
  }

  let duration: string | null = null;
  if (completedSession.endedAt && completedSession.startedAt) {
    const diffMs = new Date(completedSession.endedAt).getTime() - new Date(completedSession.startedAt).getTime();
    duration = formatDurationStr(diffMs);
  }

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
    stats: parsedStats ? {
      durationMs: (parsedStats as any).durationMs ?? 0,
      totalCostUsd: (parsedStats as any).totalCostUsd ?? 0,
      inputTokens: (parsedStats as any).inputTokens ?? 0,
      outputTokens: (parsedStats as any).outputTokens ?? 0,
      numTurns: (parsedStats as any).numTurns ?? 1,
      model: (parsedStats as any).model ?? summary.model,
      success: (parsedStats as any).success ?? false,
    } : null,
    ...summary,
  };
}

export async function getIssuesByProject(
  projectId: string,
  issueNumber?: number,
  database: Database = db,
) {
  const whereClause = issueNumber
    ? and(eq(issues.projectId, projectId), eq(issues.issueNumber, issueNumber))
    : eq(issues.projectId, projectId);

  return database
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
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause)
    .orderBy(issues.sortOrder);
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
