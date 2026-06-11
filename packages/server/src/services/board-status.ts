import { db } from "../db/index.js";
import { projects, projectStatuses, issues, workspaces, sessions, preferences, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { isTerminalStatusIdView, ACTIVE_WORKSPACE_STATUSES, workspaceStatusPriority } from "@agentic-kanban/shared";
import type { BoardStatusResponse, BoardStatusIssue } from "@agentic-kanban/shared";
import { isAnalyticsNoise } from "./session-filter.js";
import {
  classifyBoardStatusIssueAttention,
  classifyBoardStatusIssueMergeState,
  type BoardStatusClassificationOptions,
} from "./board-status-classifiers.js";
import { collectBoardStatusEntryWork, type ConflictCacheEntry } from "./board-status-enrichment.js";

export { classifyBoardStatusIssueAttention, classifyBoardStatusIssueMergeState } from "./board-status-classifiers.js";

// In-memory conflict cache: workspaceId → { result, timestamp }
const conflictCache = new Map<string, ConflictCacheEntry>();
const CONFLICT_CACHE_TTL = 60_000; // 60 seconds

type WorkspaceRow = typeof workspaces.$inferSelect;

export interface BoardStatusOptions {
  projectId?: string;
  includeClosed?: boolean;
  tailLines?: number;
}

function parseSessionStats(stats: string): BoardStatusIssue["sessionStats"] {
  try {
    const p = JSON.parse(stats);
    return {
      durationMs: p.durationMs ?? 0,
      totalCostUsd: p.totalCostUsd ?? 0,
      inputTokens: p.inputTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      numTurns: p.numTurns ?? 1,
      model: p.model ?? "",
      success: p.success ?? false,
      agentSummary: p.agentSummary,
    };
  } catch {
    return null; // ignore bad stats JSON
  }
}

/**
 * Picks the most relevant workspace for an issue (by status priority, then
 * recency) and resolves the issue's effective status name from the
 * workspace's current workflow node (falling back to the issue's own status).
 */
function selectMainWorkspace(
  wsForIssue: WorkspaceRow[],
  fallbackStatusName: string,
  currentNodeStatusById: Map<string, string | null>,
  statusByName: Map<string, { id: string; name: string }>,
): { mainWs: WorkspaceRow | null; effectiveStatusName: string } {
  const mainWs = wsForIssue.sort((a, b) =>
    workspaceStatusPriority(a.status) - workspaceStatusPriority(b.status) ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  )[0] ?? null;
  const workflowStatusName = mainWs?.status !== "closed" && mainWs?.currentNodeId
    ? currentNodeStatusById.get(mainWs.currentNodeId)
    : null;
  const effectiveStatusName = workflowStatusName
    ? statusByName.get(workflowStatusName.toLowerCase())?.name ?? fallbackStatusName
    : fallbackStatusName;
  return { mainWs, effectiveStatusName };
}

export async function getBoardStatus(
  options: BoardStatusOptions = {},
  database: typeof db = db,
): Promise<BoardStatusResponse> {
  const { includeClosed = false, tailLines = 5 } = options;

  // 1. Resolve project
  let projectId = options.projectId;
  if (!projectId) {
    const pref = await database
      .select({ value: preferences.value })
      .from(preferences)
      .where(eq(preferences.key, "activeProjectId"))
      .limit(1);
    if (pref.length === 0) throw new Error("No active project");
    projectId = pref[0].value;
  }

  const projectRows = await database
    .select({ id: projects.id, name: projects.name, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (projectRows.length === 0) throw new Error(`Project ${projectId} not found`);
  const project = projectRows[0];

  const preferenceRows = await database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(inArray(preferences.key, ["auto_merge", "auto_merge_in_review"]));
  const preferenceMap = new Map(preferenceRows.map((pref) => [pref.key, pref.value]));
  const classificationOptions: BoardStatusClassificationOptions = {
    autoMergeEnabled: preferenceMap.get("auto_merge") === "true",
    autoMergeInReview: preferenceMap.get("auto_merge_in_review") === "true",
  };

  // 2. Get statuses to identify terminal ones (legacy fallback for non-workflow issues)
  const statuses = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
  const terminalStatusIds = new Set(
    statuses.filter(s => s.name === "Done" || s.name === "Cancelled").map(s => s.id),
  );

  // 3. Get issues with status names + current workflow node type (LEFT JOIN so
  //    non-workflow issues are still returned with nodeType = null).
  let projectIssues = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
      issueType: issues.issueType,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));

  if (!includeClosed) {
    projectIssues = projectIssues.filter(i => !isTerminalStatusIdView(i, terminalStatusIds));
  }

  if (projectIssues.length === 0) {
    return {
      project: { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch },
      generatedAt: new Date().toISOString(),
      totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 },
      issues: [],
    };
  }

  const issueIds = projectIssues.map(i => i.id);

  // 4. Get workspaces for these issues
  const wsRows = await database.select().from(workspaces).where(inArray(workspaces.issueId, issueIds));
  const currentNodeIds = [
    ...new Set(
      wsRows
        .filter((w) => w.status !== "closed" && w.currentNodeId)
        .map((w) => w.currentNodeId as string),
    ),
  ];
  const currentNodeStatuses = currentNodeIds.length > 0
    ? await database
        .select({ id: workflowNodes.id, statusName: workflowNodes.statusName })
        .from(workflowNodes)
        .where(inArray(workflowNodes.id, currentNodeIds))
    : [];
  const currentNodeStatusById = new Map(currentNodeStatuses.map((node) => [node.id, node.statusName]));
  const statusByName = new Map(statuses.map((status) => [status.name.toLowerCase(), status]));

  // 5. Get sessions for these workspaces
  const wsIds = wsRows.map(w => w.id);
  const sessionRows = wsIds.length > 0
    ? await database.select().from(sessions).where(inArray(sessions.workspaceId, wsIds))
    : [];

  // Group sessions by workspaceId (most recent first)
  const sessionsByWs = new Map<string, typeof sessionRows>();
  for (const s of sessionRows) {
    const arr = sessionsByWs.get(s.workspaceId) ?? [];
    arr.push(s);
    sessionsByWs.set(s.workspaceId, arr);
  }
  for (const [, arr] of sessionsByWs) {
    arr.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  }

  // Group workspaces by issueId
  const wsByIssue = new Map<string, typeof wsRows>();
  for (const ws of wsRows) {
    const arr = wsByIssue.get(ws.issueId) ?? [];
    arr.push(ws);
    wsByIssue.set(ws.issueId, arr);
  }

  // 6. For each issue, assemble the overview
  const result: BoardStatusIssue[] = [];
  const asyncWork: Promise<void>[] = [];

  for (const issue of projectIssues) {
    const { mainWs, effectiveStatusName } = selectMainWorkspace(
      wsByIssue.get(issue.id) ?? [],
      issue.statusName,
      currentNodeStatusById,
      statusByName,
    );

    const mainSessions = mainWs ? (sessionsByWs.get(mainWs.id) ?? []) : [];
    // Prefer the latest non-noise session for analytics; fall back to latest overall
    const latestSession = mainSessions.find(s => !isAnalyticsNoise(s)) ?? mainSessions[0] ?? null;

    const entry: BoardStatusIssue = {
      issueNumber: issue.issueNumber,
      issueId: issue.id,
      title: issue.title,
      priority: issue.priority,
      issueType: issue.issueType,
      statusName: effectiveStatusName,
      workspace: mainWs ? {
        id: mainWs.id, branch: mainWs.branch, status: mainWs.status,
        workingDir: mainWs.workingDir, baseBranch: mainWs.baseBranch, isDirect: mainWs.isDirect,
        readyForMerge: mainWs.readyForMerge,
      } : null,
      session: latestSession ? {
        id: latestSession.id, status: latestSession.status,
        startedAt: latestSession.startedAt, endedAt: latestSession.endedAt,
      } : null,
      sessionStats: latestSession?.stats ? parseSessionStats(latestSession.stats) : null,
      diffStats: null,
      conflicts: null,
      lastActivity: null,
      lastOutput: [],
      lastAgentMessage: null,
      attention: null,
      mergeState: null,
    };

    // For non-closed workspaces with a workingDir: compute diff stats + last output
    if (mainWs) {
      asyncWork.push(...collectBoardStatusEntryWork(entry, mainWs, latestSession?.id ?? null, {
        defaultBranch: project.defaultBranch,
        database,
        tailLines,
        conflictCache,
        conflictCacheTtl: CONFLICT_CACHE_TTL,
      }));
    }

    result.push(entry);
  }

  await Promise.all(asyncWork);

  for (const issue of result) {
    issue.mergeState = classifyBoardStatusIssueMergeState(issue, classificationOptions);
    issue.attention = classifyBoardStatusIssueAttention(issue);
  }

  return {
    project: { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch },
    generatedAt: new Date().toISOString(),
    totals: {
      totalIssues: projectIssues.length,
      inProgress: result.filter(i => i.statusName === "In Progress" || i.statusName === "In Review").length,
      activeWorkspaces: wsRows.filter(w => ACTIVE_WORKSPACE_STATUSES.has(w.status)).length,
      runningSessions: sessionRows.filter(s => s.status === "running").length,
    },
    issues: result,
  };
}
