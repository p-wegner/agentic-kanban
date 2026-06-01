import { workspaces, sessions, sessionMessages, showdowns, workflowEdges, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { detectConflicts, getCommitCountAhead, getDiffShortstat } from "./git.service.js";
import type { ProviderName } from "./agent-provider.js";
import { isAnalyticsNoise } from "./session-filter.js";
import { computeWorkspaceCodeMetrics, parseStoredWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import type { WorkspaceCodeMetrics } from "@agentic-kanban/shared";

// Limit concurrent background git operations to avoid hammering the filesystem
let _bgGitRunning = 0;
const BG_GIT_CONCURRENCY = 5;

function runBgGit(fn: () => Promise<void>): void {
  if (_bgGitRunning >= BG_GIT_CONCURRENCY) return;
  _bgGitRunning++;
  fn().finally(() => { _bgGitRunning--; });
}

const CONFLICT_CACHE_TTL_MS = 5 * 60 * 1000;
const DIFF_STAT_CACHE_TTL_MS = 30 * 1000;
const CODE_METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

export type WorkspaceSummary = {
  total: number;
  active: number;
  idle: number;
  closed: number;
  branches: string[];
  showdown?: {
    id: string;
    status: string;
    total: number;
    doneCount: number;
  };
  main?: {
    id: string;
    branch: string;
    status: "active" | "reviewing" | "fixing" | "idle" | "awaiting-plan-approval" | "error" | "closed";
    claudeProfile: string | null;
    profile?: { provider: ProviderName; name: string } | null;
    model?: string | null;
    agentCommand: string | null;
    readyForMerge?: boolean;
    planMode?: boolean;
    diffStats?: { filesChanged: number; insertions: number; deletions: number } | null;
    conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
    lastSessionAt?: string | null;
    sessionStatus?: string | null;
    lastSessionTriggerType?: string | null;
    mergedAt?: string | null;
    contextTokens?: number | null;
    lastTool?: string | null;
    lastAssistantMessage?: string | null;
    pendingPlanPath?: string | null;
    planOnlyWarning?: boolean;
    scorecard?: { score: number } | null;
    commitCount?: number | null;
    codeMetrics?: WorkspaceCodeMetrics | null;
    workflow?: {
      currentNodeId: string;
      currentNodeName: string;
      currentNodeType: string;
      currentNodeStatusName: string | null;
      state: "active" | "waiting" | "terminal";
      nextStages: string[];
    } | null;
  };
};

function extractAssistantMessage(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "assistant") {
        const content = (obj.message as { content?: unknown[] })?.content ?? [];
        for (const block of [...content].reverse() as { type: string; text?: string }[]) {
          if (block.type === "text" && block.text?.trim()) return block.text.trim();
        }
      }
      if (obj.type === "assistant.message") {
        const messageData = obj.data as Record<string, unknown> | undefined;
        const raw = messageData?.content;
        const contentStr = typeof raw === "string" ? raw
          : Array.isArray(raw)
            ? (raw as { type?: string; text?: string }[])
                .filter(b => b.type === "text" && typeof b.text === "string")
                .map(b => b.text as string)
                .join("\n")
            : "";
        if (contentStr.trim()) return contentStr.trim();
      }
      if (
        obj.type === "item.completed"
        && (obj.item as { type?: string; text?: string } | undefined)?.type === "agent_message"
      ) {
        const text = (obj.item as { text?: string }).text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}

function extractToolName(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type !== "assistant") continue;
      const content = (obj.message as { content?: unknown[] })?.content ?? [];
      for (const block of content as { type: string; name?: string }[]) {
        if (block.type === "tool_use" && block.name) return block.name;
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}

export async function buildWorkspaceSummaryMap(
  issueIds: string[],
  defaultBranch: string | null,
  database: Database,
): Promise<Map<string, WorkspaceSummary>> {
  const workspaceSummaryMap = new Map<string, WorkspaceSummary>();
  if (issueIds.length === 0) return workspaceSummaryMap;

  // Aggregate counts per issue+status
  const wsRows = await database
    .select({
      issueId: workspaces.issueId,
      status: workspaces.status,
      branch: workspaces.branch,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds))
    .groupBy(workspaces.issueId, workspaces.status, workspaces.branch);

  for (const row of wsRows) {
    let summary = workspaceSummaryMap.get(row.issueId);
    if (!summary) {
      summary = { total: 0, active: 0, idle: 0, closed: 0, branches: [] };
      workspaceSummaryMap.set(row.issueId, summary);
    }
    summary.total += row.count;
    if (row.status === "active" || row.status === "reviewing" || row.status === "fixing" || row.status === "awaiting-plan-approval") {
      summary.active += row.count;
    } else if (row.status === "closed") {
      summary.closed += row.count;
    } else {
      summary.idle += row.count;
    }
    if (!summary.branches.includes(row.branch)) {
      summary.branches.push(row.branch);
    }
  }

  // Fetch workspace detail rows to determine main workspace per issue
  const wsDetailRows = await database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      planMode: workspaces.planMode,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      conflictCacheCheckedAt: workspaces.conflictCacheCheckedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      readyForMerge: workspaces.readyForMerge,
      diffStatCacheCheckedAt: workspaces.diffStatCacheCheckedAt,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      scorecardScore: workspaces.scorecardScore,
      codeMetricsJson: workspaces.codeMetricsJson,
      codeMetricsComputedAt: workspaces.codeMetricsComputedAt,
      currentNodeId: workspaces.currentNodeId,
      showdownId: workspaces.showdownId,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));

  // Populate showdown summary — find issues that have showdown workspaces
  const showdownIdsByIssue = new Map<string, string>();
  for (const row of wsDetailRows) {
    if (row.showdownId) showdownIdsByIssue.set(row.issueId, row.showdownId);
  }
  if (showdownIdsByIssue.size > 0) {
    const allShowdownIds = [...new Set(showdownIdsByIssue.values())];
    const showdownRows = await database
      .select({ id: showdowns.id, status: showdowns.status })
      .from(showdowns)
      .where(inArray(showdowns.id, allShowdownIds));
    const showdownStatusMap = new Map(showdownRows.map(r => [r.id, r.status]));

    for (const [issueId, showdownId] of showdownIdsByIssue) {
      const summary = workspaceSummaryMap.get(issueId);
      if (!summary) continue;
      const sdStatus = showdownStatusMap.get(showdownId) ?? "active";
      const sdWorkspaces = wsDetailRows.filter(w => w.showdownId === showdownId);
      const doneCount = sdWorkspaces.filter(w => w.status === "idle" || w.status === "closed").length;
      summary.showdown = { id: showdownId, status: sdStatus, total: sdWorkspaces.length, doneCount };
    }
  }


    // Pick main workspace per issue: active > awaiting-plan-approval > idle > closed, tie-break by updatedAt
  const statusPriority = (s: string) => s === "active" || s === "reviewing" || s === "fixing" ? 0 : s === "awaiting-plan-approval" ? 1 : s === "idle" ? 2 : 3;
  type MainWs = typeof wsDetailRows[number];
  const mainWorkspaceMap = new Map<string, MainWs>();
  for (const row of wsDetailRows) {
    const existing = mainWorkspaceMap.get(row.issueId);
    if (!existing) { mainWorkspaceMap.set(row.issueId, row); continue; }
    const existingP = statusPriority(existing.status);
    const rowP = statusPriority(row.status);
    if (rowP < existingP || (rowP === existingP && row.updatedAt > existing.updatedAt)) {
      mainWorkspaceMap.set(row.issueId, row);
    }
  }

  // Attach main workspace summary and schedule stale-while-revalidate cache refreshes
  for (const [issueId, summary] of workspaceSummaryMap) {
    const mainWs = mainWorkspaceMap.get(issueId);
    if (!mainWs) continue;

    summary.main = {
      id: mainWs.id,
      branch: mainWs.branch,
      status: mainWs.status as "active" | "reviewing" | "fixing" | "idle" | "awaiting-plan-approval" | "error" | "closed",
      claudeProfile: mainWs.claudeProfile,
      profile: mainWs.claudeProfile ? { provider: (mainWs.provider as ProviderName) ?? "claude", name: mainWs.claudeProfile } : null,
      model: mainWs.model,
      agentCommand: mainWs.agentCommand,
      readyForMerge: mainWs.readyForMerge,
      planMode: mainWs.planMode,
      pendingPlanPath: mainWs.pendingPlanPath,
      planOnlyWarning: false,
      scorecard: mainWs.scorecardScore !== null ? { score: mainWs.scorecardScore } : null,
      commitCount: null,
      codeMetrics: parseStoredWorkspaceCodeMetrics(mainWs.codeMetricsJson, mainWs.codeMetricsComputedAt),
      workflow: null,
      mergedAt: mainWs.mergedAt,
    };

    if (mainWs.workingDir && mainWs.status !== "closed") {
      const baseForCommitCount = mainWs.baseBranch || defaultBranch;
      if (!mainWs.isDirect && baseForCommitCount) {
        summary.main.commitCount = await getCommitCountAhead(mainWs.workingDir, baseForCommitCount);
      }

      const diffRef = mainWs.isDirect ? "HEAD" : (mainWs.baseBranch || defaultBranch);
      if (!diffRef) continue;
      const mainRef = summary.main;

      // Serve cached diff stats immediately
      if (mainWs.diffStatCacheCheckedAt && mainWs.diffStatCacheFilesChanged !== null) {
        if (mainWs.diffStatCacheFilesChanged > 0 || (mainWs.diffStatCacheInsertions ?? 0) > 0 || (mainWs.diffStatCacheDeletions ?? 0) > 0) {
          mainRef.diffStats = {
            filesChanged: mainWs.diffStatCacheFilesChanged,
            insertions: mainWs.diffStatCacheInsertions ?? 0,
            deletions: mainWs.diffStatCacheDeletions ?? 0,
          };
        }
      }

      // Detect plan-only sessions: idle workspace with 0 diff changes that wasn't explicitly in plan mode
      if (mainWs.status === "idle" && !mainWs.planMode && mainWs.diffStatCacheCheckedAt) {
        const hasChanges = (mainWs.diffStatCacheFilesChanged ?? 0) > 0
          || (mainWs.diffStatCacheInsertions ?? 0) > 0
          || (mainWs.diffStatCacheDeletions ?? 0) > 0;
        if (!hasChanges) {
          mainRef.planOnlyWarning = true;
        }
      }

      // Background refresh if cache is stale or missing
      const diffCacheAge = mainWs.diffStatCacheCheckedAt
        ? Date.now() - new Date(mainWs.diffStatCacheCheckedAt).getTime()
        : Infinity;
      if (diffCacheAge >= DIFF_STAT_CACHE_TTL_MS) {
        const wsId = mainWs.id;
        const workingDir = mainWs.workingDir;
        runBgGit(() =>
          getDiffShortstat(workingDir, diffRef)
            .then(stats => {
              database.update(workspaces).set({
                diffStatCacheCheckedAt: new Date().toISOString(),
                diffStatCacheFilesChanged: stats.filesChanged,
                diffStatCacheInsertions: stats.insertions,
                diffStatCacheDeletions: stats.deletions,
              }).where(eq(workspaces.id, wsId)).catch(() => {});
            })
            .catch(() => {})
        );
      }

      // Conflict detection for non-direct idle workspaces — stale-while-revalidate
      const codeMetricsCacheAge = mainWs.codeMetricsComputedAt
        ? Date.now() - new Date(mainWs.codeMetricsComputedAt).getTime()
        : Infinity;
      if (codeMetricsCacheAge >= CODE_METRICS_CACHE_TTL_MS) {
        const wsId = mainWs.id;
        runBgGit(() =>
          computeWorkspaceCodeMetrics(wsId, database)
            .then((metrics) => {
              if (metrics && summary.main?.id === wsId) summary.main.codeMetrics = metrics;
            })
            .catch(() => {})
        );
      }

      if (!mainWs.isDirect && mainWs.status === "idle") {
        const conflictCacheAge = mainWs.conflictCacheCheckedAt
          ? Date.now() - new Date(mainWs.conflictCacheCheckedAt).getTime()
          : Infinity;
        if (mainWs.conflictCacheCheckedAt && conflictCacheAge < CONFLICT_CACHE_TTL_MS) {
          if (mainWs.conflictCacheHasConflicts !== null) {
            mainRef.conflicts = {
              hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
              conflictingFiles: mainWs.conflictCacheFiles ? JSON.parse(mainWs.conflictCacheFiles) : [],
            };
          }
        } else {
          if (mainWs.conflictCacheCheckedAt && mainWs.conflictCacheHasConflicts !== null) {
            mainRef.conflicts = {
              hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
              conflictingFiles: mainWs.conflictCacheFiles ? JSON.parse(mainWs.conflictCacheFiles) : [],
            };
          }
          const wsId = mainWs.id;
          const baseBranch = mainWs.baseBranch || defaultBranch;
          if (!baseBranch) continue;
          const workingDir = mainWs.workingDir;
          runBgGit(() =>
            detectConflicts(workingDir, baseBranch)
              .then(result => {
                database.update(workspaces).set({
                  conflictCacheCheckedAt: new Date().toISOString(),
                  conflictCacheHasConflicts: result.hasConflicts,
                  conflictCacheFiles: JSON.stringify(result.conflictingFiles),
                }).where(eq(workspaces.id, wsId)).catch(() => {});
              })
              .catch(() => {})
          );
        }
      }
    }
  }

  const currentNodeIds = [...mainWorkspaceMap.values()]
    .map((w) => w.currentNodeId)
    .filter((id): id is string => !!id);
  if (currentNodeIds.length > 0) {
    const currentNodes = await database
      .select({
        id: workflowNodes.id,
        name: workflowNodes.name,
        nodeType: workflowNodes.nodeType,
        statusName: workflowNodes.statusName,
      })
      .from(workflowNodes)
      .where(inArray(workflowNodes.id, currentNodeIds));
    const currentNodeById = new Map(currentNodes.map((n) => [n.id, n]));

    const outgoingEdges = await database
      .select({
        fromNodeId: workflowEdges.fromNodeId,
        toNodeId: workflowEdges.toNodeId,
        sortOrder: workflowEdges.sortOrder,
      })
      .from(workflowEdges)
      .where(inArray(workflowEdges.fromNodeId, currentNodeIds));
    const targetNodeIds = [...new Set(outgoingEdges.map((e) => e.toNodeId))];
    const targetNodes = targetNodeIds.length > 0
      ? await database
          .select({ id: workflowNodes.id, name: workflowNodes.name })
          .from(workflowNodes)
          .where(inArray(workflowNodes.id, targetNodeIds))
      : [];
    const targetNameById = new Map(targetNodes.map((n) => [n.id, n.name]));

    const nextStagesByNode = new Map<string, string[]>();
    for (const edge of outgoingEdges.sort((a, b) => a.sortOrder - b.sortOrder)) {
      const targetName = targetNameById.get(edge.toNodeId);
      if (!targetName) continue;
      const names = nextStagesByNode.get(edge.fromNodeId) ?? [];
      names.push(targetName);
      nextStagesByNode.set(edge.fromNodeId, names);
    }

    for (const [issueId, summary] of workspaceSummaryMap) {
      const main = summary.main;
      if (!main) continue;
      const mainWs = mainWorkspaceMap.get(issueId);
      if (!mainWs?.currentNodeId) continue;
      const currentNode = currentNodeById.get(mainWs.currentNodeId);
      if (!currentNode) continue;
      const nextStages = nextStagesByNode.get(currentNode.id) ?? [];
      const isTerminal = currentNode.nodeType === "end" || nextStages.length === 0;
      const isRunning = main.status === "active" || main.status === "reviewing" || main.status === "fixing";
      main.workflow = {
        currentNodeId: currentNode.id,
        currentNodeName: currentNode.name,
        currentNodeType: currentNode.nodeType,
        currentNodeStatusName: currentNode.statusName,
        state: isTerminal ? "terminal" : isRunning ? "active" : "waiting",
        nextStages,
      };
    }
  }

  // Fetch latest session per main workspace for timing + last output info
  const mainWsIds = [...mainWorkspaceMap.values()].map(w => w.id);
  if (mainWsIds.length > 0) {
    const sessionRows = await database
      .select({
        id: sessions.id,
        workspaceId: sessions.workspaceId,
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        stats: sessions.stats,
        triggerType: sessions.triggerType,
      })
      .from(sessions)
      .where(inArray(sessions.workspaceId, mainWsIds))
      .orderBy(sessions.startedAt);

    const latestByWs = new Map<string, { id: string; status: string; startedAt: string; endedAt: string | null; stats: string | null; triggerType: string | null }>();
    const latestNoiseByWs = new Map<string, { id: string; status: string; startedAt: string; endedAt: string | null; stats: string | null; triggerType: string | null }>();
    for (const s of sessionRows) {
      const entry = { id: s.id, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, stats: s.stats, triggerType: s.triggerType ?? null };
      if (isAnalyticsNoise(s)) {
        latestNoiseByWs.set(s.workspaceId, entry);
      } else {
        latestByWs.set(s.workspaceId, entry);
      }
    }
    // Fall back to noise sessions only for workspaces with no real sessions
    for (const [wsId, noiseSession] of latestNoiseByWs) {
      if (!latestByWs.has(wsId)) latestByWs.set(wsId, noiseSession);
    }

    const latestSessionIds = [...latestByWs.values()].map(s => s.id);
    const lastToolBySession = new Map<string, string>();
    const lastAssistantMsgBySession = new Map<string, string>();

    if (latestSessionIds.length > 0) {
      const msgRows = await database
        .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
        .from(sessionMessages)
        .where(inArray(sessionMessages.sessionId, latestSessionIds))
        .orderBy(desc(sessionMessages.id));

      for (const msg of msgRows) {
        const hasTool = lastToolBySession.has(msg.sessionId);
        const hasMsg = lastAssistantMsgBySession.has(msg.sessionId);
        if (hasTool && hasMsg) continue;
        if (!msg.data) continue;
        if (!hasTool) {
          const toolName = extractToolName(msg.data);
          if (toolName) lastToolBySession.set(msg.sessionId, toolName);
        }
        if (!hasMsg) {
          const assistantMessage = extractAssistantMessage(msg.data);
          if (assistantMessage) lastAssistantMsgBySession.set(msg.sessionId, assistantMessage);
        }
      }
    }

    for (const [, summary] of workspaceSummaryMap) {
      if (!summary.main) continue;
      const sess = latestByWs.get(summary.main.id);
      if (!sess) continue;
      summary.main.lastSessionAt = sess.status === "running" ? sess.startedAt : sess.endedAt;
      summary.main.sessionStatus = sess.status;
      summary.main.lastSessionTriggerType = sess.triggerType;
      if (sess.stats) {
        try {
          const p = JSON.parse(sess.stats) as Record<string, unknown>;
          const explicitContextTokens = (p.contextTokens as number) ?? 0;
          const inputTokens = (p.inputTokens as number) ?? 0;
          const cachedTokens = (p.cacheReadTokens as number) ?? 0;
          summary.main.contextTokens = explicitContextTokens || inputTokens + cachedTokens || null;
        } catch { /* ignore */ }
      }
      summary.main.lastTool = lastToolBySession.get(sess.id) ?? null;
      summary.main.lastAssistantMessage = lastAssistantMsgBySession.get(sess.id) ?? null;
    }
  }

  return workspaceSummaryMap;
}
