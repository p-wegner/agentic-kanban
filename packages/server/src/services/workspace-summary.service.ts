import { existsSync } from "node:fs";
import type { Database } from "../db/index.js";
import { detectConflicts, getDiffShortstat } from "./git.service.js";
import { isGitProjectionFresh, refreshWorkspaceGitProjection } from "./workspace-summary-projection.service.js";
import type { ProviderName } from "./agent-provider.js";
import { isAnalyticsNoise } from "./session-filter.js";
import { computeWorkspaceCodeMetrics, parseStoredWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import type { WorkspaceCodeMetrics, WorkspaceSummary } from "@agentic-kanban/shared";
import { ACTIVE_WORKSPACE_STATUSES, workspaceStatusPriority } from "@agentic-kanban/shared";
import { readSessionStdoutFileTailAsync } from "../lib/session-output-reader.js";
import { extractAssistantMessage, extractToolName, safeParseStringArray } from "../lib/session-message-extraction.js";
import { selectLatestSessionsByWorkspace, parseContextTokensFromStats } from "../lib/workspace-summary-session.js";
import { selectCachedDiffStats, isPlanOnlySession, isDiffCacheStale } from "../lib/workspace-diff-cache.js";
import {
  aggregateWorkspaceCountRows,
  fetchWorkspaceDetailRows,
  getShowdownStatuses,
  updateWorkspaceDiffStatCache,
  updateWorkspaceConflictCache,
  getWorkflowNodesByIds,
  getOutgoingWorkflowEdges,
  getWorkflowNodeNamesByIds,
  getSessionsForWorkspaces,
  getSessionStatsByIds,
  getSessionMessagesForSessions,
} from "../repositories/workspace-summary.repository.js";
import { notifySummaryWriteThrough } from "./summary-write-through-notifier.js";

// Bounded fan-out for background git-backed refresh tasks. The REAL git concurrency
// control is the process-wide semaphore inside the git-exec adapter (#398) — this
// limit only caps how many refresh TASKS are in flight at once so a huge board does
// not build thousands of pending promises.
//
// #398: this used to be drop-over-cap (`if (running >= cap) return;`) — the 6th+
// workspace's refresh was SILENTLY discarded, so the summary cache never warmed past
// the 5th workspace and every later board rebuild re-paid those git calls inline.
// Over-cap work now QUEUES and always runs; dropping only happens past a queue bound
// that steady-state never reaches, and is logged when it does.
let _bgGitRunning = 0;
const BG_GIT_CONCURRENCY = 5;
const BG_GIT_MAX_QUEUE = 1000;
const _bgGitQueue: Array<() => Promise<void>> = [];

/** Exported for tests only — callers inside this module schedule via the helpers below. */
export function runBgGit(fn: () => Promise<void>): void {
  if (_bgGitRunning >= BG_GIT_CONCURRENCY) {
    if (_bgGitQueue.length >= BG_GIT_MAX_QUEUE) {
      // The exception, not the norm: only a pathological backlog is dropped, loudly.
      console.warn(`[workspace-summary] bg git queue full (${BG_GIT_MAX_QUEUE}); dropping a refresh task`);
      return;
    }
    _bgGitQueue.push(fn);
    return;
  }
  _bgGitRunning++;
  void runBgGitTask(fn);
}

async function runBgGitTask(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Refresh tasks are best-effort; failures must never wedge the lane.
  } finally {
    const next = _bgGitQueue.shift();
    if (next) {
      void runBgGitTask(next);
    } else {
      _bgGitRunning--;
    }
  }
}

const CONFLICT_CACHE_TTL_MS = 5 * 60 * 1000;
const DIFF_STAT_CACHE_TTL_MS = 30 * 1000;
const CODE_METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

export type { WorkspaceSummary } from "@agentic-kanban/shared";

type MainWorkspaceInfo = NonNullable<WorkspaceSummary["main"]>;

export async function buildWorkspaceSummaryMap(
  issueIds: string[],
  defaultBranch: string | null,
  database: Database,
  // Issues in archive columns (Done/Cancelled). Their cards render via CompletedCard,
  // which never shows lastAssistantMessage/lastTool — so the per-session message scan
  // is skipped for their main workspaces regardless of workspace status.
  archivedIssueIds?: Set<string>,
): Promise<Map<string, WorkspaceSummary>> {
  if (issueIds.length === 0) return new Map<string, WorkspaceSummary>();

  // G14b: existsSync used to run TWICE per main workspace per rebuild (phase 4 +
  // phase 5). One rebuild pass shares a single stat per distinct workingDir.
  const dirExistsCache = new Map<string, boolean>();
  const dirExists = (path: string): boolean => {
    let known = dirExistsCache.get(path);
    if (known === undefined) {
      known = existsSync(path);
      dirExistsCache.set(path, known);
    }
    return known;
  };

  // Phase 1: aggregate workspace counts per issue+status
  const workspaceSummaryMap = await aggregateWorkspaceCounts(issueIds, database);

  // Fetch workspace detail rows to determine main workspace per issue
  const wsDetailRows = await fetchWorkspaceDetailRows(issueIds, database);

  // Phase 2: populate showdown summary metadata
  await populateShowdownSummaries(wsDetailRows, workspaceSummaryMap, database);

  // Phase 3: pick main workspace per issue
  const mainWorkspaceMap = selectMainWorkspaces(wsDetailRows, archivedIssueIds);

  // Phase 4: read commit counts / latest commits from the persisted git projection
  // (#399, decision 014) — zero git spawns on this path; stale rows get a bg refresh.
  const { commitCountByIssue, latestCommitByIssue } = readGitProjection(mainWorkspaceMap, defaultBranch, database, dirExists, archivedIssueIds);

  // Phase 5: attach main workspace summary and schedule stale-while-revalidate cache refreshes
  for (const [issueId, summary] of workspaceSummaryMap) {
    const mainWs = mainWorkspaceMap.get(issueId);
    if (!mainWs) continue;

    const isArchivedIssue = archivedIssueIds?.has(issueId) ?? false;

    summary.main = {
      id: mainWs.id,
      branch: mainWs.branch,
      workingDir: mainWs.workingDir,
      status: mainWs.status as "active" | "reviewing" | "fixing" | "idle" | "blocked" | "awaiting-plan-approval" | "error" | "closed",
      claudeProfile: mainWs.claudeProfile,
      profile: mainWs.claudeProfile ? { provider: (mainWs.provider as ProviderName) ?? "claude", name: mainWs.claudeProfile } : null,
      model: mainWs.model,
      agentCommand: mainWs.agentCommand,
      readyForMerge: mainWs.readyForMerge,
      planMode: mainWs.planMode,
      pendingPlanPath: mainWs.pendingPlanPath,
      planOnlyWarning: false,
      scorecard: mainWs.scorecardScore !== null ? { score: mainWs.scorecardScore } : null,
      commitCount: commitCountByIssue.get(issueId) ?? null,
      latestCommit: latestCommitByIssue.get(issueId) ?? null,
      // Skip JSON parse for archived issues — CompletedCard never renders codeMetrics
      codeMetrics: isArchivedIssue ? null : parseStoredWorkspaceCodeMetrics(mainWs.codeMetricsJson, mainWs.codeMetricsComputedAt),
      workflow: null,
      mergedAt: mainWs.mergedAt,
    };

    // Skip background git/metrics refreshes for archived issues — CompletedCard shows none of these fields.
    // The existsSync is the same point as in prefetchGitData: a set-but-vanished
    // workingDir would otherwise schedule diff-stat + conflict-detection git spawns
    // that can only fail, on every board build (#277).
    if (!isArchivedIssue && mainWs.workingDir && mainWs.status !== "closed" && dirExists(mainWs.workingDir)) {
      const diffRef = mainWs.isDirect ? "HEAD" : (mainWs.baseBranch || defaultBranch);
      if (!diffRef) continue;
      const mainRef = summary.main;
      const currentHeadSha = latestCommitByIssue.get(issueId)?.sha ?? null;

      applyDiffStats(mainWs, diffRef, currentHeadSha, mainRef, database);
      scheduleCodeMetricsRefresh(mainWs, summary, database);
      applyConflicts(mainWs, defaultBranch, database, mainRef);
    }
  }

  // Phase 6: populate workflow transition info
  await populateWorkflowInfo(mainWorkspaceMap, workspaceSummaryMap, database, archivedIssueIds);

  // Phase 7+8: fetch latest sessions and attach last tool / assistant message
  await attachSessionData(mainWorkspaceMap, workspaceSummaryMap, database, archivedIssueIds);

  return workspaceSummaryMap;
}

// Phase 1: aggregate counts per issue+status into a fresh summary map.
async function aggregateWorkspaceCounts(issueIds: string[], database: Database): Promise<Map<string, WorkspaceSummary>> {
  const workspaceSummaryMap = new Map<string, WorkspaceSummary>();

  const wsRows = await aggregateWorkspaceCountRows(issueIds, database);

  for (const row of wsRows) {
    let summary = workspaceSummaryMap.get(row.issueId);
    if (!summary) {
      summary = { total: 0, active: 0, idle: 0, closed: 0, branches: [] };
      workspaceSummaryMap.set(row.issueId, summary);
    }
    summary.total += row.count;
    if (ACTIVE_WORKSPACE_STATUSES.has(row.status)) {
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

  return workspaceSummaryMap;
}

type WorkspaceDetailRow = Awaited<ReturnType<typeof fetchWorkspaceDetailRows>>[number];

// Phase 2: populate showdown summary — find issues that have showdown workspaces.
async function populateShowdownSummaries(
  wsDetailRows: WorkspaceDetailRow[],
  workspaceSummaryMap: Map<string, WorkspaceSummary>,
  database: Database,
): Promise<void> {
  const showdownIdsByIssue = new Map<string, string>();
  // G14d: group rows by showdown once (O(W)) instead of re-filtering all detail
  // rows per issue inside the loop below (O(W²) on showdown-heavy boards).
  const rowsByShowdown = new Map<string, WorkspaceDetailRow[]>();
  for (const row of wsDetailRows) {
    if (!row.showdownId) continue;
    showdownIdsByIssue.set(row.issueId, row.showdownId);
    const group = rowsByShowdown.get(row.showdownId);
    if (group) group.push(row);
    else rowsByShowdown.set(row.showdownId, [row]);
  }
  if (showdownIdsByIssue.size === 0) return;

  const allShowdownIds = [...new Set(showdownIdsByIssue.values())];
  const showdownRows = await getShowdownStatuses(allShowdownIds, database);
  const showdownStatusMap = new Map(showdownRows.map(r => [r.id, r.status]));

  for (const [issueId, showdownId] of showdownIdsByIssue) {
    const summary = workspaceSummaryMap.get(issueId);
    if (!summary) continue;
    const sdStatus = showdownStatusMap.get(showdownId) ?? "active";
    const sdWorkspaces = rowsByShowdown.get(showdownId) ?? [];
    const doneCount = sdWorkspaces.filter(w => w.status === "idle" || w.status === "closed").length;
    summary.showdown = { id: showdownId, status: sdStatus, total: sdWorkspaces.length, doneCount };
  }
}

// Phase 3: pick main workspace per issue: active > awaiting-plan-approval > idle > closed,
// tie-break by updatedAt.
function selectMainWorkspaces(
  wsDetailRows: WorkspaceDetailRow[],
  archivedIssueIds?: Set<string>,
): Map<string, WorkspaceDetailRow> {
  const mainWorkspaceMap = new Map<string, WorkspaceDetailRow>();
  for (const row of wsDetailRows) {
    const existing = mainWorkspaceMap.get(row.issueId);
    if (!existing) { mainWorkspaceMap.set(row.issueId, row); continue; }
    const existingP = workspaceStatusPriority(existing.status);
    const rowP = workspaceStatusPriority(row.status);
    if (rowP < existingP || (rowP === existingP && row.updatedAt > existing.updatedAt)) {
      mainWorkspaceMap.set(row.issueId, row);
    }
  }

  // #663: Omit closed workspaces from main for non-archived issues (Backlog/Todo/etc).
  // Archived issues (Done/Cancelled) keep their closed/merged main workspace for display.
  // Closed workspaces remain in the counts (total/closed) and in issue detail/history APIs.
  for (const [issueId, ws] of mainWorkspaceMap) {
    if (ws.status === "closed" && !archivedIssueIds?.has(issueId)) {
      mainWorkspaceMap.delete(issueId);
    }
  }

  return mainWorkspaceMap;
}

// Phase 4 (#399, decision 014): serve commit counts and latest commits from the PERSISTED
// git projection on the workspace row — a pure map over rows already fetched, so the hot
// path spawns no git and awaits nothing. This replaced the in-memory gitOpsCache SWR map
// (which died on every tsx-watch restart, re-paying 2 spawns × N workspaces per boot, and
// paid first sightings INLINE). A row whose projection is stale or dirty is still served
// as-is (last-known values, SWR) while a deduped background refresh writes new facts
// through to the row — see workspace-summary-projection.service.ts, which also chains the
// HEAD-advance → diff-stat refresh the inline prefetch used to provide.
function readGitProjection(
  mainWorkspaceMap: Map<string, WorkspaceDetailRow>,
  defaultBranch: string | null,
  database: Database,
  dirExists: (path: string) => boolean,
  archivedIssueIds?: Set<string>,
): {
  commitCountByIssue: Map<string, number | null>;
  latestCommitByIssue: Map<string, { sha: string; message: string } | null>;
} {
  const commitCountByIssue = new Map<string, number | null>();
  const latestCommitByIssue = new Map<string, { sha: string; message: string } | null>();
  const nowMs = Date.now();
  for (const [issueId, ws] of mainWorkspaceMap) {
    // `workingDir` being SET is not the same as it EXISTING. A worktree that was
    // removed (or lived in a since-deleted fixture repo) still has its path on the
    // row, and each such workspace would otherwise schedule 2 doomed git spawns on
    // every board build (#277). A stat gets the same answer for free.
    if (archivedIssueIds?.has(issueId)) continue;
    if (!ws.workingDir || ws.status === "closed" || !dirExists(ws.workingDir)) continue;

    latestCommitByIssue.set(
      issueId,
      ws.summaryHeadSha ? { sha: ws.summaryHeadSha, message: ws.summaryHeadMessage ?? "" } : null,
    );
    if (!ws.isDirect && !!(ws.baseBranch || defaultBranch) && ws.summaryCommitCount !== null) {
      commitCountByIssue.set(issueId, ws.summaryCommitCount);
    }

    if (!isGitProjectionFresh(ws, nowMs)) {
      runBgGit(() => refreshWorkspaceGitProjection(ws, defaultBranch, database));
    }
  }
  return { commitCountByIssue, latestCommitByIssue };
}

// Phase 5a: serve cached diff stats, flag plan-only sessions, and schedule a background
// diff-stat refresh when HEAD advanced or the cache is missing/stale.
function applyDiffStats(
  mainWs: WorkspaceDetailRow,
  diffRef: string,
  currentHeadSha: string | null,
  mainRef: MainWorkspaceInfo,
  database: Database,
): void {
  // Serve cached diff stats immediately (null = no usable cache entry yet)
  const cached = selectCachedDiffStats(mainWs);
  if (cached) mainRef.diffStats = cached;

  // Flag plan-only sessions: idle, not plan-mode, computed diff shows zero changes
  if (isPlanOnlySession(mainWs)) mainRef.planOnlyWarning = true;

  // Background refresh when HEAD advanced or cache is missing/stale
  if (isDiffCacheStale(mainWs, currentHeadSha, DIFF_STAT_CACHE_TTL_MS, Date.now())) {
    const wsId = mainWs.id;
    const workingDir = mainWs.workingDir!;
    const headShaAtRefresh = currentHeadSha;
    // G13: only a write that CHANGED the board-visible numbers invalidates the
    // board ETag generation — a steady-state refresh rewriting identical stats
    // must not thrash the memo.
    runBgGit(() =>
      getDiffShortstat(workingDir, diffRef)
        .then(stats => {
          const changed =
            stats.filesChanged !== mainWs.diffStatCacheFilesChanged ||
            stats.insertions !== mainWs.diffStatCacheInsertions ||
            stats.deletions !== mainWs.diffStatCacheDeletions;
          updateWorkspaceDiffStatCache(wsId, {
            diffStatCacheCheckedAt: new Date().toISOString(),
            diffStatCacheHeadSha: headShaAtRefresh,
            diffStatCacheFilesChanged: stats.filesChanged,
            diffStatCacheInsertions: stats.insertions,
            diffStatCacheDeletions: stats.deletions,
          }, database)
            .then(() => { if (changed) notifySummaryWriteThrough(wsId); })
            .catch(() => {});
        })
        .catch(() => {})
    );
  }
}

// Phase 5b: schedule a background code-metrics recompute when the cache is stale.
function scheduleCodeMetricsRefresh(
  mainWs: WorkspaceDetailRow,
  summary: WorkspaceSummary,
  database: Database,
): void {
  const codeMetricsCacheAge = mainWs.codeMetricsComputedAt
    ? Date.now() - new Date(mainWs.codeMetricsComputedAt).getTime()
    : Infinity;
  if (codeMetricsCacheAge < CODE_METRICS_CACHE_TTL_MS) return;
  const wsId = mainWs.id;
  const previousMetricsJson = mainWs.codeMetricsJson;
  runBgGit(() =>
    computeWorkspaceCodeMetrics(wsId, database)
      .then((metrics: WorkspaceCodeMetrics | null) => {
        if (metrics && summary.main?.id === wsId) summary.main.codeMetrics = metrics;
        // G13: computeWorkspaceCodeMetrics wrote the row through — invalidate the
        // board ETag generation only when the metric VALUES moved (computedAt
        // always changes, so compare the payload fields, not the whole blob).
        if (metrics && codeMetricsValuesChanged(previousMetricsJson, metrics)) {
          notifySummaryWriteThrough(wsId);
        }
      })
      .catch(() => {})
  );
}

/** Whether freshly computed code metrics differ from the previously stored blob,
 * ignoring the always-moving `computedAt` stamp (G13 change gate). */
function codeMetricsValuesChanged(previousJson: string | null, metrics: WorkspaceCodeMetrics): boolean {
  if (!previousJson) return true;
  try {
    const prev = JSON.parse(previousJson) as WorkspaceCodeMetrics;
    return JSON.stringify({ coverage: prev.coverage ?? null, lint: prev.lint ?? null, complexity: prev.complexity ?? null })
      !== JSON.stringify({ coverage: metrics.coverage ?? null, lint: metrics.lint ?? null, complexity: metrics.complexity ?? null });
  } catch {
    return true;
  }
}

// Phase 5c: conflict detection for non-direct idle/fixing workspaces — stale-while-revalidate.
function applyConflicts(
  mainWs: WorkspaceDetailRow,
  defaultBranch: string | null,
  database: Database,
  mainRef: MainWorkspaceInfo,
): void {
  if (mainWs.isDirect || (mainWs.status !== "idle" && mainWs.status !== "fixing")) return;

  const conflictCacheAge = mainWs.conflictCacheCheckedAt
    ? Date.now() - new Date(mainWs.conflictCacheCheckedAt).getTime()
    : Infinity;
  if (mainWs.conflictCacheCheckedAt && conflictCacheAge < CONFLICT_CACHE_TTL_MS) {
    if (mainWs.conflictCacheHasConflicts !== null) {
      mainRef.conflicts = {
        hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
        conflictingFiles: safeParseStringArray(mainWs.conflictCacheFiles),
      };
    }
  } else {
    if (mainWs.conflictCacheCheckedAt && mainWs.conflictCacheHasConflicts !== null) {
      mainRef.conflicts = {
        hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
        conflictingFiles: safeParseStringArray(mainWs.conflictCacheFiles),
      };
    }
    // For fixing workspaces, don't run background conflict detection (agent is resolving them);
    // serve cached data only.
    if (mainWs.status === "idle") {
      const wsId = mainWs.id;
      const baseBranch = mainWs.baseBranch || defaultBranch;
      if (!baseBranch) return;
      const workingDir = mainWs.workingDir!;
      runBgGit(() =>
        detectConflicts(workingDir, baseBranch)
          .then(result => {
            // G13 change gate — see applyDiffStats.
            const files = JSON.stringify(result.conflictingFiles);
            const changed =
              result.hasConflicts !== mainWs.conflictCacheHasConflicts ||
              files !== mainWs.conflictCacheFiles;
            updateWorkspaceConflictCache(wsId, {
              conflictCacheCheckedAt: new Date().toISOString(),
              conflictCacheHasConflicts: result.hasConflicts,
              conflictCacheFiles: files,
            }, database)
              .then(() => { if (changed) notifySummaryWriteThrough(wsId); })
              .catch(() => {});
          })
          .catch(() => {})
      );
    }
  }
}

// Phase 6: fetch workflow nodes/edges and attach workflow transition info to each
// summary's main workspace.
async function populateWorkflowInfo(
  mainWorkspaceMap: Map<string, WorkspaceDetailRow>,
  workspaceSummaryMap: Map<string, WorkspaceSummary>,
  database: Database,
  archivedIssueIds?: Set<string>,
): Promise<void> {
  const currentNodeIds = [...mainWorkspaceMap.values()]
    .map((w) => w.currentNodeId)
    .filter((id): id is string => !!id);
  if (currentNodeIds.length === 0) return;

  const currentNodes = await getWorkflowNodesByIds(currentNodeIds, database);
  const currentNodeById = new Map(currentNodes.map((n) => [n.id, n]));

  const outgoingEdges = await getOutgoingWorkflowEdges(currentNodeIds, database);
  const targetNodeIds = [...new Set(outgoingEdges.map((e) => e.toNodeId))];
  const targetNodes = targetNodeIds.length > 0
    ? await getWorkflowNodeNamesByIds(targetNodeIds, database)
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
    // Workflow nodes irrelevant for archived issues — CompletedCard never renders them
    if (archivedIssueIds?.has(issueId)) continue;
    const main = summary.main;
    if (!main) continue;
    const mainWs = mainWorkspaceMap.get(issueId);
    if (!mainWs?.currentNodeId) continue;
    const currentNode = currentNodeById.get(mainWs.currentNodeId);
    if (!currentNode) continue;
    const nextStages = nextStagesByNode.get(currentNode.id) ?? [];
    const isTerminal = currentNode.nodeType === "end" || nextStages.length === 0;
    const isRunning = ACTIVE_WORKSPACE_STATUSES.has(main.status);
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

// Phases 7+8: fetch latest session per main workspace for timing + last output info,
// then extract and attach last tool / assistant message from .out files or DB.
async function attachSessionData(
  mainWorkspaceMap: Map<string, WorkspaceDetailRow>,
  workspaceSummaryMap: Map<string, WorkspaceSummary>,
  database: Database,
  archivedIssueIds?: Set<string>,
): Promise<void> {
  const mainWsIds = [...mainWorkspaceMap.values()].map(w => w.id);
  if (mainWsIds.length === 0) return;

  const sessionRows = await getSessionsForWorkspaces(mainWsIds, database);
  const latestByWs = selectLatestSessionsByWorkspace(sessionRows, isAnalyticsNoise);

  // G9: the session list query no longer ships every historical session's stats
  // blob — fetch stats for just the ~1-per-workspace winner rows in one small
  // IN query (contextTokens is attached for every main, closed included).
  const statsRows = await getSessionStatsByIds([...latestByWs.values()].map((s) => s.id), database);
  const statsBySession = new Map(statsRows.map((r) => [r.id, r.stats]));

  // lastTool / lastAssistantMessage are only consumed for non-closed, non-archived
  // workspaces (AgentGrid hides closed; MonitorPopover only shows active/reviewing/
  // fixing; board cards never render lastAssistantMessage; archived issues render via
  // CompletedCard which shows neither). For closed (merged) workspaces and archived
  // (Done/Cancelled) issues — the overwhelming majority on a mature board — the
  // assistant-message text blob is pure payload weight. Skip the (potentially large)
  // session_messages scan for them so those fields stay null: this is the dominant
  // board-payload reduction.
  const skipMessageScanWsIds = new Set(
    [...mainWorkspaceMap.values()]
      .filter((w) => w.status === "closed" || archivedIssueIds?.has(w.issueId))
      .map((w) => w.id),
  );
  const latestSessionIds = [...latestByWs.entries()]
    .filter(([wsId]) => !skipMessageScanWsIds.has(wsId))
    .map(([, s]) => s.id);

  const { lastToolBySession, lastAssistantMsgBySession } =
    await collectLastToolAndMessages(latestSessionIds, database);

  for (const [, summary] of workspaceSummaryMap) {
    if (!summary.main) continue;
    const sess = latestByWs.get(summary.main.id);
    if (!sess) continue;
    summary.main.lastSessionAt = sess.status === "running" ? sess.startedAt : sess.endedAt;
    summary.main.sessionStatus = sess.status;
    summary.main.lastSessionTriggerType = sess.triggerType;
    const stats = statsBySession.get(sess.id) ?? null;
    if (stats) summary.main.contextTokens = parseContextTokensFromStats(stats);
    summary.main.lastTool = lastToolBySession.get(sess.id) ?? null;
    summary.main.lastAssistantMessage = lastAssistantMsgBySession.get(sess.id) ?? null;
  }
}

// Phase 8 I/O: for each candidate session, derive its last tool name and last
// assistant message — preferring the live .out stdout file and falling back to the
// persisted session_messages rows for historical sessions with no file.

/** Bounded fan-out for the per-session .out tail reads (#401). */
const TAIL_READ_CONCURRENCY = 5;

async function collectLastToolAndMessages(
  latestSessionIds: string[],
  database: Database,
): Promise<{ lastToolBySession: Map<string, string>; lastAssistantMsgBySession: Map<string, string> }> {
  const lastToolBySession = new Map<string, string>();
  const lastAssistantMsgBySession = new Map<string, string>();
  if (latestSessionIds.length === 0) return { lastToolBySession, lastAssistantMsgBySession };

  // Prefer .out file for stdout; fall back to DB for historical sessions.
  //
  // BOUNDED read (#341): this used to be a full readFileSync of every candidate
  // session's transcript on the event loop. %TEMP% holds multi-MB .out files
  // (5.5 MB measured), and a board/graph rebuild does this for every non-closed
  // main workspace — tens of MB of synchronous I/O per cold rebuild, which
  // blocks the single Node thread for every other request. The last tool /
  // assistant message lives in the final JSONL lines by construction, so a
  // 256 KB tail is sufficient; readSessionStdoutFileTail drops the partial
  // first line so callers only ever see complete lines.
  //
  // Side effect, deliberate: extractToolName/extractAssistantMessage return the
  // FIRST match in the window they are given, so with a whole-file read
  // `lastTool` was really the session's FIRST tool. Over a tail window it now
  // reflects recent activity, which is what the field name promises.
  //
  // ASYNC + bounded fan-out (#401): the tail reads used to be synchronous
  // (openSync/readSync, 256 KB each) in a sequential for-loop — one event-loop
  // block per non-closed workspace per board rebuild. They now run through
  // fs.promises with a small worker pool so at most TAIL_READ_CONCURRENCY file
  // handles are open at once and the loop stays free between reads.
  const needsDb: string[] = [];
  let nextIdx = 0;
  const tailWorker = async (): Promise<void> => {
    while (nextIdx < latestSessionIds.length) {
      const sid = latestSessionIds[nextIdx++];
      const fileContent = await readSessionStdoutFileTailAsync(sid);
      if (fileContent === null) {
        needsDb.push(sid);
        continue;
      }
      const toolName = extractToolName(fileContent);
      if (toolName) lastToolBySession.set(sid, toolName);
      const assistantMessage = extractAssistantMessage(fileContent);
      if (assistantMessage) lastAssistantMsgBySession.set(sid, assistantMessage);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TAIL_READ_CONCURRENCY, latestSessionIds.length) }, tailWorker),
  );

  if (needsDb.length > 0) {
    const msgRows = await getSessionMessagesForSessions(needsDb, database);
    for (const msg of msgRows) {
      const hasTool = lastToolBySession.has(msg.sessionId);
      const hasMsg = lastAssistantMsgBySession.has(msg.sessionId);
      if ((hasTool && hasMsg) || !msg.data) continue;
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

  return { lastToolBySession, lastAssistantMsgBySession };
}
