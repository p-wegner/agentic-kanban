import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { isCodexUsageLimitStats } from "./codex-rate-limit.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { parseSessionStats } from "../startup/monitor-cycle-rules.js";
import {
  getAllPreferences,
  getActiveAutodriveWorkspaceRows,
  getLatestSessionForWorkspace,
  getFixAndMergeSessionCount,
  getProgressIssueRows,
  getProgressWorkspaceRows,
  getProgressSessionRows,
} from "../repositories/autodrive-stall-warning.repository.js";

const ACTIVE_AUTODRIVE_STATUS_NAMES = ["In Progress", "In Review"] as const;
const ACTIVE_WORKSPACE_STATUSES = ["active", "reviewing", "fixing", "idle", "blocked"] as const;
const DEFAULT_STALL_WARNING_MIN = 20;
const FIX_AND_MERGE_ZOMBIE_SESSION_COUNT = 2;

export type AutodriveStallCause =
  | "hung_zero_token_builder"
  | "provider_usage_limit"
  | "fix_and_merge_zombie"
  | "in_review_auto_merge_stalled"
  | "no_progress";

export interface AutodriveStallWarning {
  type: "autodrive_stall";
  projectId: string;
  projectName: string;
  detectedAt: string;
  thresholdMin: number;
  stalledForMin: number;
  lastProgressAt: string;
  activeIssueCount: number;
  workspaceIds: string[];
  issueNumbers: number[];
  cause: AutodriveStallCause;
  message: string;
}

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
    const legacy = /^board_autodrive_([0-9a-f-]+)$/.exec(key);
    if (legacy && value === "true") ids.add(legacy[1]);

    const startMode = /^start_mode_([0-9a-f-]+)$/.exec(key);
    if (startMode && (value === "monitor" || value === "conductor")) ids.add(startMode[1]);
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

function classifyCause(rows: ActiveWorkspaceWithSessions[], prefMap: Map<string, string>): AutodriveStallCause {
  if (rows.some((row) => isCodexUsageLimitStats(row.latestSession?.stats))) return "provider_usage_limit";

  if (rows.some((row) => {
    const sess = row.latestSession;
    if (!sess || sess.status !== "running") return false;
    const tokenTotal = sessionTokenTotal(sess.stats);
    const builderLike = !sess.triggerType || sess.triggerType === "agent" || sess.triggerType === "chat" || sess.triggerType === "plan-implement";
    return builderLike && (tokenTotal === null || tokenTotal === 0);
  })) return "hung_zero_token_builder";

  if (rows.some((row) => row.workspaceStatus === "fixing" || row.fixAndMergeSessionCount >= FIX_AND_MERGE_ZOMBIE_SESSION_COUNT)) {
    return "fix_and_merge_zombie";
  }

  const autoMergeOn = prefMap.get("auto_merge") === "true";
  const autoMergeInReview = prefMap.get("auto_merge_in_review") === "true";
  if (autoMergeOn && rows.some((row) => {
    const disabled = prefMap.get(`auto_merge_disabled_${row.projectId}`) === "true";
    return !disabled && row.statusName === "In Review" && (row.readyForMerge || autoMergeInReview || row.workspaceStatus === "reviewing");
  })) return "in_review_auto_merge_stalled";

  return "no_progress";
}

function causeLabel(cause: AutodriveStallCause): string {
  switch (cause) {
    case "hung_zero_token_builder": return "latest builder appears hung with no token output";
    case "provider_usage_limit": return "latest session hit a provider usage limit";
    case "fix_and_merge_zombie": return "fix-and-merge appears to be looping";
    case "in_review_auto_merge_stalled": return "In-Review work is eligible for auto-merge but has not landed";
    case "no_progress": return "no recent status, workspace, session, or merge progress";
  }
}

async function attachSessions(database: Database, rows: ActiveWorkspaceRow[]): Promise<ActiveWorkspaceWithSessions[]> {
  const result: ActiveWorkspaceWithSessions[] = [];
  for (const row of rows) {
    const latestSession = await getLatestSessionForWorkspace(row.workspaceId, database);
    const fixAndMergeSessionCount = await getFixAndMergeSessionCount(row.workspaceId, database);
    result.push({
      ...row,
      latestSession,
      fixAndMergeSessionCount,
    });
  }
  return result;
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
    const cause = classifyCause(projectRows, prefs);
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
