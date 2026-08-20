import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { isBuilderCycleTrigger } from "@agentic-kanban/shared/lib/session-trigger";
import { readUsageLimitStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import type { Database } from "../db/index.js";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { db } from "../db/index.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { classifyQuotaBlock, parseSessionStats } from "./monitor-cycle-rules.js";
import { isAutoMergeEnabled } from "@agentic-kanban/shared/lib/auto-merge-pref";
import type { AutodriveStallWarning } from "@agentic-kanban/shared/types";
import {
  getAllPreferences,
  getActiveAutodriveWorkspaceRows,
  getSessionSummariesForWorkspaces,
  getProgressIssueRows,
  getProgressWorkspaceRows,
  getProgressSessionRows,
} from "../repositories/autodrive-stall-warning.repository.js";

const ACTIVE_AUTODRIVE_STATUS_NAMES = ["In Progress", "In Review"] as const;
const ACTIVE_WORKSPACE_STATUSES = ["active", "reviewing", "fixing", "idle", "blocked"] as const;
const DEFAULT_STALL_WARNING_MIN = 20;
const FIX_AND_MERGE_ZOMBIE_SESSION_COUNT = 2;

const autodrivePref = projectPref("board_autodrive");
const startModePref = projectPref("start_mode");

export type AutodriveStallCause =
  | "hung_zero_token_builder"
  | "provider_usage_limit"
  | "provider_usage_limit_expired"
  | "fix_and_merge_zombie"
  | "in_review_auto_merge_stalled"
  | "no_progress"
  | "unblocked_backlog_not_started";

// Shape lives in shared (#567) — it is one arm of the monitor-status warning union.
export type { AutodriveStallWarning };

interface ActiveWorkspaceRow {
  projectId: string;
  projectName: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  statusName: string;
  issueUpdatedAt: string;
  issueStatusChangedAt: string | null;
  workspaceId: string;
  workspaceStatus: string;
  workspaceUpdatedAt: string;
  workspaceCreatedAt: string;
  readyForMerge: boolean;
}

interface LatestSessionRow {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats: string | null;
  triggerType: string | null;
}

interface ActiveWorkspaceWithSessions extends ActiveWorkspaceRow {
  latestSession: LatestSessionRow | null;
  fixAndMergeSessionCount: number;
}

export function parseStallWarningThresholdMin(prefMap: Map<string, string>): number {
  const configured = Number(prefMap.get("monitor_stall_warning_min"));
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_WARNING_MIN;
}

function explicitAutoDrivenProjectIds(prefMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of prefMap) {
    const legacyProjectId = autodrivePref.projectIdOf(key);
    if (legacyProjectId && value === "true") ids.add(legacyProjectId);

    const startModeProjectId = startModePref.projectIdOf(key);
    if (startModeProjectId && (value === "monitor" || value === "conductor")) ids.add(startModeProjectId);
  }
  return ids;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const max = Math.max(...values.map(timestampMs));
  return max > 0 ? new Date(max).toISOString() : null;
}

function addProgress(progressByProject: Map<string, string[]>, projectId: string, ...values: Array<string | null | undefined>): void {
  const list = progressByProject.get(projectId) ?? [];
  for (const value of values) {
    if (value) list.push(value);
  }
  progressByProject.set(projectId, list);
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sessionTokenTotal(stats: string | null): number | null {
  if (!stats) return null;
  const parsed = parseSessionStats(stats);
  return numberValue(parsed.inputTokens)
    + numberValue(parsed.outputTokens)
    + numberValue(parsed.cacheReadTokens)
    + numberValue(parsed.contextTokens);
}

function classifyCause(rows: ActiveWorkspaceWithSessions[], prefMap: Map<string, string>, nowMs: number): AutodriveStallCause {
  // Both providers, not just Codex. A Claude quota death used to fall through to
  // "no_progress" — the least actionable bucket — so a stall that self-heals at a known
  // reset time read identically to a genuinely wedged workspace. Measured: a step agent
  // died on a Claude session limit and its stall warning said "no recent progress" for
  // 55 minutes while the real cause (and its reset time) sat in the session stats.
  //
  // But the reset time has to be COMPARED TO THE CLOCK (#387). The stats row is immutable,
  // so a blocked workspace re-supplies the same usage-limit blob on every scan forever, and
  // the label kept claiming "waiting on quota" for days after the quota had demonstrably
  // reset — a self-healing condition that was not healing, which is the least actionable
  // report of all because it tells the reader to wait.
  const quotaRows = rows.filter((row) => readUsageLimitStats(row.latestSession?.stats) !== null);
  if (quotaRows.length > 0) {
    const stillWaiting = quotaRows.some((row) => {
      const block = classifyQuotaBlock(row.latestSession, nowMs);
      return block !== null && !block.expired;
    });
    return stillWaiting ? "provider_usage_limit" : "provider_usage_limit_expired";
  }

  if (rows.some((row) => {
    const sess = row.latestSession;
    if (!sess || sess.status !== "running") return false;
    const tokenTotal = sessionTokenTotal(sess.stats);
    const builderLike = isBuilderCycleTrigger(sess.triggerType);
    return builderLike && (tokenTotal === null || tokenTotal === 0);
  })) return "hung_zero_token_builder";

  if (rows.some((row) => row.workspaceStatus === "fixing" || row.fixAndMergeSessionCount >= FIX_AND_MERGE_ZOMBIE_SESSION_COUNT)) {
    return "fix_and_merge_zombie";
  }

  const autoMergeOn = isAutoMergeEnabled(prefMap);
  const autoMergeInReview = getBool(prefMap, "auto_merge_in_review");
  if (autoMergeOn && rows.some((row) => {
    const disabled = prefMap.get(`auto_merge_disabled_${row.projectId}`) === "true";
    return !disabled && row.statusName === "In Review" && (row.readyForMerge || autoMergeInReview || row.workspaceStatus === "reviewing");
  })) return "in_review_auto_merge_stalled";

  return "no_progress";
}

function causeLabel(cause: AutodriveStallCause): string {
  switch (cause) {
    case "hung_zero_token_builder": return "latest builder appears hung with no token output";
    case "provider_usage_limit": return "latest session hit a provider usage limit and is still inside its reset window";
    case "provider_usage_limit_expired": return "latest session hit a provider usage limit whose reset time has already passed — wedged, not waiting";
    case "fix_and_merge_zombie": return "fix-and-merge appears to be looping";
    case "in_review_auto_merge_stalled": return "In-Review work is eligible for auto-merge but has not landed";
    case "no_progress": return "no recent status, workspace, session, or merge progress";
    case "unblocked_backlog_not_started": return "unblocked Backlog/Todo work is queued but was not auto-started this cycle";
  }
}

const SKIP_REASON_LABEL: Record<string, string> = {
  wip_cap: "WIP cap reached",
  no_auto_start_tag: "opted out via no-auto-start tag",
  contention_gate: "deferred by file-contention gate",
  cycle_start_cap: "hit this cycle's max-new-starts cap",
  feature_type_excluded: "excluded by feature/enhancement type filter",
};

/**
 * Turns the per-project skip tallies `runAutoStart` collects while declining to start
 * otherwise-unblocked Backlog/Todo issues into `autodrive_stall`-shaped warnings, so a
 * monitor-mode project that looks idle (#179 — `monitor-status` showed
 * `merged:0, relaunched:0, nudged:0` with zero explanation) gets a named reason instead
 * of silence. Reuses the `autodrive_stall` warning type/UI rather than inventing a new
 * one, per the existing "Monitor warnings" rendering.
 */
export function buildAutoStartSkipWarnings(
  skipByProject: Map<string, { issueNumbers: number[]; reasonCounts: Partial<Record<string, number>> }>,
  projectNames: Map<string, string>,
  now: Date,
): AutodriveStallWarning[] {
  const warnings: AutodriveStallWarning[] = [];
  for (const [projectId, info] of skipByProject) {
    const reasonParts = Object.entries(info.reasonCounts)
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([reason, count]) => `${SKIP_REASON_LABEL[reason] ?? reason} (${count})`);
    if (reasonParts.length === 0) continue;
    const projectName = projectNames.get(projectId) ?? projectId;
    const issueNumbers = [...info.issueNumbers].sort((a, b) => a - b);
    const issuePreview = issueNumbers.length > 0 ? ` issue(s) #${issueNumbers.slice(0, 5).join(", #")}` : "";
    warnings.push({
      type: "autodrive_stall",
      projectId,
      projectName,
      detectedAt: now.toISOString(),
      thresholdMin: 0,
      stalledForMin: 0,
      lastProgressAt: now.toISOString(),
      activeIssueCount: issueNumbers.length,
      workspaceIds: [],
      issueNumbers,
      cause: "unblocked_backlog_not_started",
      message: `Monitor-mode project "${projectName}" had unblocked work not auto-started this cycle for${issuePreview}: ${reasonParts.join(", ")}.`,
    });
  }
  return warnings;
}

async function attachSessions(database: Database, rows: ActiveWorkspaceRow[]): Promise<ActiveWorkspaceWithSessions[]> {
  // Two round trips for the whole batch, not two per workspace (#349) — see
  // `getSessionSummariesForWorkspaces`.
  const summaries = await getSessionSummariesForWorkspaces(rows.map((row) => row.workspaceId), database);
  return rows.map((row) => {
    const summary = summaries.get(row.workspaceId);
    return {
      ...row,
      latestSession: summary?.latestSession ?? null,
      fixAndMergeSessionCount: summary?.fixAndMergeSessionCount ?? 0,
    };
  });
}

async function collectProjectProgress(database: Database, projectIds: string[]): Promise<Map<string, string[]>> {
  const progressByProject = new Map<string, string[]>();
  const issueRows = await getProgressIssueRows(projectIds, database);
  for (const row of issueRows) {
    addProgress(progressByProject, row.projectId, row.updatedAt, row.statusChangedAt);
  }

  const workspaceRows = await getProgressWorkspaceRows(projectIds, database);
  for (const row of workspaceRows) {
    addProgress(progressByProject, row.projectId, row.createdAt, row.updatedAt, row.mergedAt);
  }

  const sessionRows = await getProgressSessionRows(projectIds, database);
  for (const row of sessionRows) {
    addProgress(progressByProject, row.projectId, row.startedAt, row.endedAt);
  }

  return progressByProject;
}

export async function scanAutodriveStallWarnings(
  database: Database = db,
  prefMap?: Map<string, string>,
  now = new Date(),
): Promise<AutodriveStallWarning[]> {
  const prefs = prefMap ?? new Map((await getAllPreferences(database)).map((r) => [r.key, r.value]));
  const autoDrivenIds = explicitAutoDrivenProjectIds(prefs);
  if (autoDrivenIds.size === 0) return [];

  const thresholdMin = parseStallWarningThresholdMin(prefs);
  const thresholdMs = thresholdMin * 60 * 1000;
  const projectIds = [...autoDrivenIds].filter((projectId) => resolveStartPolicy(prefs, projectId).mode !== "manual");
  if (projectIds.length === 0) return [];

  const activeRows = await getActiveAutodriveWorkspaceRows(
    projectIds,
    [...ACTIVE_AUTODRIVE_STATUS_NAMES],
    [...ACTIVE_WORKSPACE_STATUSES],
    database,
  );
  if (activeRows.length === 0) return [];

  const rows = await attachSessions(database, activeRows);
  const progressByProject = await collectProjectProgress(database, projectIds);
  const byProject = new Map<string, ActiveWorkspaceWithSessions[]>();
  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? [];
    list.push(row);
    byProject.set(row.projectId, list);
  }

  const warnings: AutodriveStallWarning[] = [];
  const nowMs = now.getTime();
  for (const projectRows of byProject.values()) {
    const projectProgress = progressByProject.get(projectRows[0].projectId) ?? [];
    const lastProgressAt = maxIso([
      ...projectProgress,
      ...projectRows.flatMap((row) => [
      row.issueStatusChangedAt,
      row.issueUpdatedAt,
      row.workspaceCreatedAt,
      row.workspaceUpdatedAt,
      row.latestSession?.startedAt,
      row.latestSession?.endedAt,
      ]),
    ]);
    if (!lastProgressAt) continue;

    const stalledMs = nowMs - new Date(lastProgressAt).getTime();
    if (stalledMs < thresholdMs) continue;

    const [first] = projectRows;
    const issueNumbers = [...new Set(projectRows.map((row) => row.issueNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    const workspaceIds = [...new Set(projectRows.map((row) => row.workspaceId))];
    const cause = classifyCause(projectRows, prefs, nowMs);
    const stalledForMin = Math.floor(stalledMs / 60_000);
    const issuePreview = issueNumbers.length > 0 ? ` issue(s) #${issueNumbers.slice(0, 5).join(", #")}` : " active issue(s)";
    warnings.push({
      type: "autodrive_stall",
      projectId: first.projectId,
      projectName: first.projectName,
      detectedAt: now.toISOString(),
      thresholdMin,
      stalledForMin,
      lastProgressAt,
      activeIssueCount: new Set(projectRows.map((row) => row.issueId)).size,
      workspaceIds,
      issueNumbers,
      cause,
      message: `Auto-driven project "${first.projectName}" has had no forward progress for ${stalledForMin}m (threshold ${thresholdMin}m) with${issuePreview} still active; likely cause: ${causeLabel(cause)}.`,
    });
  }

  return warnings;
}

export { DEFAULT_STALL_WARNING_MIN };
