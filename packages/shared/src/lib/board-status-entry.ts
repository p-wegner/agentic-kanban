import type { BoardStatusIssue } from "../types/api.js";

// Pure assembly helpers for the board-status projection (a grouped
// issue/workspace/session → a BoardStatusIssue entry). Side-effect-free, so the
// projection + session selection are directly unit-testable.
//
// SINGLE SOURCE OF TRUTH across packages: the server service (board-status.ts) and
// the mcp-server `get_board_status` tool both build the SAME wire entry. They used
// to fork this (the mcp tool inlined its own PersistedSessionStats parse + entry
// assembly), so a change to the projection silently gave MCP agents a different
// board than humans — the exact drift that already forced board-status-classifiers
// to be consolidated here. Lives in shared/lib (deep-path, no node builtins) so
// both consume one implementation.

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

/**
 * The fields read off a parsed session `stats` blob. All optional because the
 * blob is untrusted JSON; each read applies a `?? default` fallback below. This
 * mirrors the non-null `BoardStatusIssue["sessionStats"]` wire shape.
 */
type ParsedSessionStats = Partial<NonNullable<BoardStatusIssue["sessionStats"]>>;

/** Parse a session `stats` blob into the board-status shape; null on bad JSON. */
export function parseSessionStats(stats: string): BoardStatusIssue["sessionStats"] {
  try {
    const p = JSON.parse(stats) as ParsedSessionStats;
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
 * filled in later by the caller; classification fields stay null until the
 * post-pass.
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
