import { db } from "../db/index.js";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages, preferences } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { getDiffShortstat } from "./git.service.js";
import { extractMeaningfulOutput } from "@agentic-kanban/shared";
import type { BoardStatusResponse, BoardStatusIssue } from "@agentic-kanban/shared";

export interface BoardStatusOptions {
  projectId?: string;
  includeClosed?: boolean;
  tailLines?: number;
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

  // 2. Get statuses to identify terminal ones
  const statuses = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
  const terminalStatusIds = new Set(
    statuses.filter(s => s.name === "Done" || s.name === "Cancelled").map(s => s.id),
  );

  // 3. Get issues with status names
  let projectIssues = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));

  if (!includeClosed) {
    projectIssues = projectIssues.filter(i => !terminalStatusIds.has(i.statusId));
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
    const wsForIssue = wsByIssue.get(issue.id) ?? [];
    const mainWs = wsForIssue.sort((a, b) => {
      const p = (s: string) => s === "active" ? 0 : s === "reviewing" ? 1 : s === "idle" ? 2 : 3;
      return p(a.status) - p(b.status) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    })[0] ?? null;

    const mainSessions = mainWs ? (sessionsByWs.get(mainWs.id) ?? []) : [];
    const latestSession = mainSessions[0] ?? null;

    let sessionStats: BoardStatusIssue["sessionStats"] = null;
    if (latestSession?.stats) {
      try {
        const p = JSON.parse(latestSession.stats);
        sessionStats = {
          durationMs: p.durationMs ?? 0,
          totalCostUsd: p.totalCostUsd ?? 0,
          inputTokens: p.inputTokens ?? 0,
          outputTokens: p.outputTokens ?? 0,
          numTurns: p.numTurns ?? 1,
          model: p.model ?? "",
          success: p.success ?? false,
        };
      } catch { /* ignore bad stats JSON */ }
    }

    const entry: BoardStatusIssue = {
      issueNumber: issue.issueNumber,
      issueId: issue.id,
      title: issue.title,
      priority: issue.priority,
      statusName: issue.statusName,
      workspace: mainWs ? {
        id: mainWs.id, branch: mainWs.branch, status: mainWs.status,
        workingDir: mainWs.workingDir, baseBranch: mainWs.baseBranch, isDirect: mainWs.isDirect,
      } : null,
      session: latestSession ? {
        id: latestSession.id, status: latestSession.status,
        startedAt: latestSession.startedAt, endedAt: latestSession.endedAt,
      } : null,
      sessionStats,
      diffStats: null,
      lastActivity: null,
      lastOutput: [],
    };

    // For non-closed workspaces with a workingDir: compute diff stats + last output
    if (mainWs && mainWs.workingDir && mainWs.status !== "closed") {
      const baseBranch = mainWs.baseBranch || project.defaultBranch;
      const diffRef = mainWs.isDirect ? "HEAD" : baseBranch;

      asyncWork.push(
        getDiffShortstat(mainWs.workingDir, diffRef)
          .then(stats => { entry.diffStats = stats; })
          .catch((err) => { console.error(`[board-status] diff failed for ${mainWs.branch}:`, err instanceof Error ? err.message : String(err)); }),
      );

      if (latestSession) {
        asyncWork.push(
          (async () => {
            const msgs = await database
              .select({ type: sessionMessages.type, data: sessionMessages.data, createdAt: sessionMessages.createdAt })
              .from(sessionMessages)
              .where(eq(sessionMessages.sessionId, latestSession.id))
              .orderBy(desc(sessionMessages.id))
              .limit(50);

            if (msgs.length > 0 && msgs[0].createdAt) {
              entry.lastActivity = msgs[0].createdAt;
            }

            // Messages are DESC, reverse for chronological order
            entry.lastOutput = extractMeaningfulOutput(msgs.reverse(), tailLines);
          })(),
        );
      }
    }

    result.push(entry);
  }

  await Promise.all(asyncWork);

  return {
    project: { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch },
    generatedAt: new Date().toISOString(),
    totals: {
      totalIssues: projectIssues.length,
      inProgress: projectIssues.filter(i => i.statusName === "In Progress" || i.statusName === "In Review").length,
      activeWorkspaces: wsRows.filter(w => w.status === "active" || w.status === "reviewing").length,
      runningSessions: sessionRows.filter(s => s.status === "running").length,
    },
    issues: result,
  };
}
