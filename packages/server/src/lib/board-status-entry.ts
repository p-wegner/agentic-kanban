import type { BoardStatusIssue } from "@agentic-kanban/shared";

// Pure assembly helpers extracted from board-status.getBoardStatus. The service
// owns the queries + grouping; these turn a grouped issue/workspace/session into
// the BoardStatusIssue entry. Side-effect-free, so the projection + session
// selection are directly unit-testable (previously DB-only).

export interface BoardStatusEntryIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  priority: string;
  issueType: string;
}

export interface BoardStatusEntryWorkspace {
  id: string;
  branch: string;
  status: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  readyForMerge: boolean;
}

export interface BoardStatusEntrySession {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats: string | null;
}

/** Parse a session `stats` blob into the board-status shape; null on bad JSON. */
export function parseSessionStats(stats: string): BoardStatusIssue["sessionStats"] {
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
 * Prefer the latest non-noise session for analytics; fall back to the latest
 * overall, else null. `sessions` is assumed most-recent-first (caller sorts).
 */
export function selectLatestRelevantSession<T extends { triggerType?: string | null }>(
  sessions: T[],
  isNoise: (s: { triggerType?: string | null }) => boolean,
): T | null {
  return sessions.find((s) => !isNoise(s)) ?? sessions[0] ?? null;
}

/**
 * Assemble a BoardStatusIssue entry. The async-enriched fields (diffStats,
 * conflicts, lastActivity, lastOutput, lastAgentMessage) start null/empty and are
 * filled in later by collectBoardStatusEntryWork; classification fields stay null
 * until the post-pass.
 */
export function buildBoardStatusEntry(
  issue: BoardStatusEntryIssue,
  effectiveStatusName: string,
  mainWs: BoardStatusEntryWorkspace | null,
  latestSession: BoardStatusEntrySession | null,
): BoardStatusIssue {
  return {
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
}
