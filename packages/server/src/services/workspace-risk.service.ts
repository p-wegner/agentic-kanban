import { getProjectById } from "../repositories/project.repository.js";
import type { Database } from "../db/index.js";
import { NotFoundError } from "../errors/index.js";
import { isAnalyticsNoise } from "./session-filter.js";
import { getChangedFileNames } from "./git.service.js";
import { readSessionStdoutFile } from "../repositories/session.repository.js";
import { countAskFollowupQuestions, computeFileOverlapCounts } from "../lib/workspace-risk-signals.js";
import {
  getProjectIssueRows,
  getProjectStatusRows,
  getRiskSessionRowsDesc,
  getSessionMessageDataForSessions,
  getWorkspaceRiskRowsForIssues,
} from "../repositories/workspace-risk.repository.js";

export type RiskLevel = "high" | "medium" | "low" | "none";

export interface RiskSignal {
  key: string;
  label: string;
  value: string | number | boolean | null;
  severity: "high" | "medium" | "low" | "none";
  detail?: string;
}

export interface WorkspaceRiskEntry {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  branch: string;
  workspaceStatus: string;
  riskLevel: RiskLevel;
  riskScore: number;
  signals: RiskSignal[];
  /** Changed files for this workspace (used for overlap computation) */
  changedFiles: string[];
}

export interface WorkspaceRiskResponse {
  projectId: string;
  generatedAt: string;
  entries: WorkspaceRiskEntry[];
}

const ACTIVE_STATUSES = new Set(["active", "reviewing", "fixing", "idle"]);
const STALE_AGE_HIGH_MS = 4 * 60 * 60 * 1000; // 4 hours
const STALE_AGE_MEDIUM_MS = 2 * 60 * 60 * 1000; // 2 hours

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  if (score >= 1) return "low";
  return "none";
}

/** Score and label a single workspace. Does not require DB — pure data-shaping. */
export function scoreWorkspaceRisk(params: {
  workspaceStatus: string;
  lastSessionAt: string | null;
  sessionStatus: string | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  recentFailureCount: number;
  pendingQuestionCount: number;
  overlapFileCount: number;
  nowMs?: number;
}): { riskScore: number; riskLevel: RiskLevel; signals: RiskSignal[] } {
  const now = params.nowMs ?? Date.now();
  const signals: RiskSignal[] = [];
  let score = 0;

  // Signal: merge conflicts
  if (params.conflicts?.hasConflicts) {
    const count = params.conflicts.conflictingFiles.length;
    score += 4;
    signals.push({
      key: "conflicts",
      label: "Merge conflicts",
      value: count,
      severity: "high",
      detail: params.conflicts.conflictingFiles.slice(0, 3).join(", "),
    });
  }

  // Signal: age / stale session
  if (params.lastSessionAt) {
    const ageMs = now - new Date(params.lastSessionAt).getTime();
    if (ageMs >= STALE_AGE_HIGH_MS) {
      score += 3;
      signals.push({
        key: "age",
        label: "Session stale",
        value: Math.round(ageMs / (60 * 60 * 1000)),
        severity: "high",
        detail: `No activity for ${Math.round(ageMs / (60 * 60 * 1000))}h`,
      });
    } else if (ageMs >= STALE_AGE_MEDIUM_MS) {
      score += 1;
      signals.push({
        key: "age",
        label: "Session aging",
        value: Math.round(ageMs / (60 * 60 * 1000)),
        severity: "medium",
        detail: `No activity for ${Math.round(ageMs / (60 * 60 * 1000))}h`,
      });
    }
  }

  // Signal: uncommitted changes
  if (params.diffStats && params.diffStats.filesChanged > 0) {
    const filesChanged = params.diffStats.filesChanged;
    if (filesChanged >= 20) {
      score += 2;
      signals.push({
        key: "uncommitted",
        label: "Large diff",
        value: filesChanged,
        severity: "high",
        detail: `${filesChanged} files changed`,
      });
    } else if (filesChanged >= 5) {
      score += 1;
      signals.push({
        key: "uncommitted",
        label: "Uncommitted changes",
        value: filesChanged,
        severity: "medium",
        detail: `${filesChanged} files changed`,
      });
    } else {
      signals.push({
        key: "uncommitted",
        label: "Uncommitted changes",
        value: filesChanged,
        severity: "low",
        detail: `${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
      });
    }
  }

  // Signal: failed launches
  if (params.recentFailureCount >= 3) {
    score += 3;
    signals.push({
      key: "failures",
      label: "Launch failures",
      value: params.recentFailureCount,
      severity: "high",
      detail: `${params.recentFailureCount} recent failures`,
    });
  } else if (params.recentFailureCount >= 1) {
    score += 1;
    signals.push({
      key: "failures",
      label: "Launch failures",
      value: params.recentFailureCount,
      severity: "medium",
      detail: `${params.recentFailureCount} recent failure${params.recentFailureCount !== 1 ? "s" : ""}`,
    });
  }

  // Signal: pending questions
  if (params.pendingQuestionCount > 0) {
    score += 2;
    signals.push({
      key: "questions",
      label: "Pending questions",
      value: params.pendingQuestionCount,
      severity: "high",
      detail: `${params.pendingQuestionCount} unanswered question${params.pendingQuestionCount !== 1 ? "s" : ""}`,
    });
  }

  // Signal: changed-file overlap with other workspaces
  if (params.overlapFileCount >= 5) {
    score += 2;
    signals.push({
      key: "overlap",
      label: "File contention",
      value: params.overlapFileCount,
      severity: "high",
      detail: `${params.overlapFileCount} files overlap with other workspaces`,
    });
  } else if (params.overlapFileCount >= 2) {
    score += 1;
    signals.push({
      key: "overlap",
      label: "File overlap",
      value: params.overlapFileCount,
      severity: "medium",
      detail: `${params.overlapFileCount} files overlap with other workspaces`,
    });
  } else if (params.overlapFileCount === 1) {
    signals.push({
      key: "overlap",
      label: "File overlap",
      value: 1,
      severity: "low",
      detail: "1 file overlaps with another workspace",
    });
  }

  return { riskScore: score, riskLevel: riskLevelFromScore(score), signals };
}

export async function getWorkspaceRisk(
  projectId: string,
  database: Database,
): Promise<WorkspaceRiskResponse> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new NotFoundError(`Project ${projectId} not found`);
  const defaultBranch = project.defaultBranch;

  const statusRows = await getProjectStatusRows(projectId, database);
  const terminalStatusIds = new Set(
    statusRows.filter((s) => s.name === "Done" || s.name === "Cancelled").map((s) => s.id),
  );
  const statusNameById = new Map(statusRows.map((s) => [s.id, s.name]));

  const issueRows = await getProjectIssueRows(projectId, database);

  const activeIssues = issueRows.filter((i) => !terminalStatusIds.has(i.statusId));
  if (activeIssues.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), entries: [] };
  }
  const activeIssueIds = activeIssues.map((i) => i.id);
  const issueById = new Map(activeIssues.map((i) => [i.id, i]));

  // Get active/idle workspaces — these are the candidates for risk scoring
  const workspaceRows = await getWorkspaceRiskRowsForIssues(activeIssueIds, database);

  // Filter to active/review/idle workspaces (exclude closed)
  const scoredWorkspaces = workspaceRows.filter((w) => ACTIVE_STATUSES.has(w.status));
  if (scoredWorkspaces.length === 0) {
    return { projectId, generatedAt: new Date().toISOString(), entries: [] };
  }

  const wsIds = scoredWorkspaces.map((w) => w.id);

  // Fetch sessions for failure count and last session timing
  const sessionRows = await getRiskSessionRowsDesc(wsIds, database);

  const latestSessionByWs = new Map<string, typeof sessionRows[0]>();
  const failureCountByWs = new Map<string, number>();
  for (const s of sessionRows) {
    if (isAnalyticsNoise(s)) continue;
    if (!latestSessionByWs.has(s.workspaceId)) {
      latestSessionByWs.set(s.workspaceId, s);
    }
    // Count failures: zero-output (≤1s or 0 tokens) OR stopped with non-zero exit
    const durationMs = s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : Infinity;
    const isZeroOutput = !!s.endedAt && (durationMs <= 1000 || (() => {
      try {
        const p = JSON.parse(s.stats ?? "{}") as Record<string, unknown>;
        return (p.inputTokens === 0 || p.inputTokens == null) && (p.outputTokens === 0 || p.outputTokens == null);
      } catch { return false; }
    })());
    const isSessionError = s.status === "stopped" && s.exitCode !== null && s.exitCode !== "0";
    if (isZeroOutput || isSessionError) {
      failureCountByWs.set(s.workspaceId, (failureCountByWs.get(s.workspaceId) ?? 0) + 1);
    }
  }

  // Fetch pending questions per workspace from session messages
  // Questions are messages of type "tool_use" with name "ask_followup_question" that haven't been answered
  // Simpler approach: count session messages with type containing "question" for running sessions
  const pendingQuestionsByWs = new Map<string, number>();
  const runningWsIds = scoredWorkspaces
    .filter((w) => {
      const sess = latestSessionByWs.get(w.id);
      return sess?.status === "running";
    })
    .map((w) => w.id);

  if (runningWsIds.length > 0) {
    const runningSessionIds = runningWsIds
      .map((wsId) => latestSessionByWs.get(wsId)?.id)
      .filter((id): id is string => !!id);

    if (runningSessionIds.length > 0) {
      // Build per-session data map: prefer .out file, fall back to DB rows
      const sessionDataMap = new Map<string, string>();
      for (const sid of runningSessionIds) {
        const fileContent = readSessionStdoutFile(sid);
        if (fileContent) {
          sessionDataMap.set(sid, fileContent);
        }
      }
      // For sessions without a .out file, fall back to DB
      const missingFromFile = runningSessionIds.filter((sid) => !sessionDataMap.has(sid));
      if (missingFromFile.length > 0) {
        const dbRows = await getSessionMessageDataForSessions(missingFromFile, database);
        for (const row of dbRows) {
          if (!row.data) continue;
          sessionDataMap.set(row.sessionId, (sessionDataMap.get(row.sessionId) ?? "") + row.data);
        }
      }

      for (const [sid, data] of sessionDataMap) {
        const count = countAskFollowupQuestions(data);
        if (count > 0) {
          const wsId = runningWsIds.find((id) => latestSessionByWs.get(id)?.id === sid);
          if (wsId) pendingQuestionsByWs.set(wsId, (pendingQuestionsByWs.get(wsId) ?? 0) + count);
        }
      }
    }
  }

  // Gather changed files per workspace for overlap computation
  const changedFilesByWs = new Map<string, string[]>();
  await Promise.allSettled(
    scoredWorkspaces
      .filter((w) => w.workingDir && (w.status === "active" || w.status === "reviewing" || w.status === "fixing"))
      .map(async (w) => {
        try {
          const diffRef = w.isDirect ? "HEAD" : (w.baseBranch || defaultBranch);
          if (!diffRef || !w.workingDir) return;
          const files = await getChangedFileNames(w.workingDir, diffRef);
          changedFilesByWs.set(w.id, files);
        } catch { /* ignore git failures */ }
      }),
  );

  // Use cached diff-stat data for workspaces we couldn't get live files for
  for (const w of scoredWorkspaces) {
    if (!changedFilesByWs.has(w.id) && w.diffStatCacheFilesChanged && w.diffStatCacheFilesChanged > 0) {
      // We don't have actual filenames from cache, leave empty — overlap will be 0
      changedFilesByWs.set(w.id, []);
    }
  }

  // Compute per-workspace overlap counts
  const overlapCountByWs = computeFileOverlapCounts(changedFilesByWs);

  // Build risk entries
  const now = Date.now();
  const entries: WorkspaceRiskEntry[] = [];

  for (const w of scoredWorkspaces) {
    const issue = issueById.get(w.issueId);
    if (!issue) continue;

    const latestSession = latestSessionByWs.get(w.id) ?? null;
    const lastSessionAt = latestSession
      ? (latestSession.status === "running" ? latestSession.startedAt : latestSession.endedAt)
      : null;

    const conflicts = w.conflictCacheCheckedAt && w.conflictCacheHasConflicts !== null
      ? {
          hasConflicts: w.conflictCacheHasConflicts ?? false,
          conflictingFiles: (() => {
            try { return JSON.parse(w.conflictCacheFiles ?? "[]") as string[]; } catch { return []; }
          })(),
        }
      : null;

    const diffStats = w.diffStatCacheCheckedAt && w.diffStatCacheFilesChanged !== null
      ? {
          filesChanged: w.diffStatCacheFilesChanged ?? 0,
          insertions: w.diffStatCacheInsertions ?? 0,
          deletions: w.diffStatCacheDeletions ?? 0,
        }
      : null;

    const { riskScore, riskLevel, signals } = scoreWorkspaceRisk({
      workspaceStatus: w.status,
      lastSessionAt,
      sessionStatus: latestSession?.status ?? null,
      diffStats,
      conflicts,
      recentFailureCount: failureCountByWs.get(w.id) ?? 0,
      pendingQuestionCount: pendingQuestionsByWs.get(w.id) ?? 0,
      overlapFileCount: overlapCountByWs.get(w.id) ?? 0,
      nowMs: now,
    });

    entries.push({
      workspaceId: w.id,
      issueId: issue.id,
      issueNumber: issue.issueNumber,
      issueTitle: issue.title,
      issueStatusName: statusNameById.get(issue.statusId) ?? "Unknown",
      branch: w.branch,
      workspaceStatus: w.status,
      riskLevel,
      riskScore,
      signals,
      changedFiles: changedFilesByWs.get(w.id) ?? [],
    });
  }

  // Sort by risk score descending, then by issue number ascending
  entries.sort((a, b) => b.riskScore - a.riskScore || (a.issueNumber ?? 0) - (b.issueNumber ?? 0));

  return { projectId, generatedAt: new Date().toISOString(), entries };
}
