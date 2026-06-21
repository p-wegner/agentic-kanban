// Pure signal helpers extracted from getWorkspaceRisk (workspace-risk.service.ts).
// Both were buried inside a DB-heavy function and therefore untestable; pulling
// them out gives the fragile bits — JSONL tool-use parsing and the O(n^2) file
// overlap count — a unit-test seam without a database.

/**
 * Count `ask_followup_question` tool_use blocks in one session's raw stdout.
 * The stream is JSONL; each line is parsed independently and non-JSON lines
 * (and any other shapes) are ignored, mirroring the agent stream's tolerance.
 */
export function countAskFollowupQuestions(data: string): number {
  let count = 0;
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "assistant") {
        const content = ((obj.message as { content?: unknown[] })?.content ?? []) as { type: string; name?: string }[];
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "ask_followup_question") {
            count++;
          }
        }
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return count;
}

/** Session fields sufficient to classify a workspace session as a launch failure. */
export interface RiskSessionClassInput {
  startedAt: string;
  endedAt: string | null;
  status: string;
  exitCode: string | null;
  stats: string | null;
}

/** True when a session's stats JSON reports zero/absent input AND output tokens. */
function hasZeroTokenStats(stats: string | null): boolean {
  try {
    const p = JSON.parse(stats ?? "{}") as Record<string, unknown>;
    return (p.inputTokens === 0 || p.inputTokens == null) && (p.outputTokens === 0 || p.outputTokens == null);
  } catch {
    return false;
  }
}

/**
 * A session counts as a recent failure when it produced no useful work
 * (ended within 1s, or with zero/absent token counts) OR was stopped with a
 * non-zero exit code. Mirrors the inline classification getWorkspaceRisk used.
 */
export function isFailedRiskSession(s: RiskSessionClassInput): boolean {
  const durationMs = s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : Infinity;
  const isZeroOutput = !!s.endedAt && (durationMs <= 1000 || hasZeroTokenStats(s.stats));
  const isSessionError = s.status === "stopped" && s.exitCode !== null && s.exitCode !== "0";
  return isZeroOutput || isSessionError;
}

/**
 * The timestamp that represents a workspace's most recent activity: a running
 * session's start, otherwise a finished session's end. Null when there is no
 * session.
 */
export function selectLastSessionAt(
  session: { status: string; startedAt: string; endedAt: string | null } | null,
): string | null {
  if (!session) return null;
  return session.status === "running" ? session.startedAt : session.endedAt;
}

/** Workspace conflict-cache columns parsed into the scorer's conflict shape. */
export interface ConflictCacheInput {
  conflictCacheCheckedAt: string | null;
  conflictCacheHasConflicts: boolean | null;
  conflictCacheFiles: string | null;
}

/**
 * Parse a workspace's cached conflict columns into the scorer's conflict input,
 * or null when the cache has not been populated. Malformed file JSON degrades to
 * an empty file list (the workspace is still flagged as conflicted).
 */
export function parseConflictCache(w: ConflictCacheInput): { hasConflicts: boolean; conflictingFiles: string[] } | null {
  if (!(w.conflictCacheCheckedAt && w.conflictCacheHasConflicts !== null)) return null;
  return {
    hasConflicts: w.conflictCacheHasConflicts ?? false,
    conflictingFiles: (() => {
      try { return JSON.parse(w.conflictCacheFiles ?? "[]") as string[]; } catch { return []; }
    })(),
  };
}

/** Workspace diff-stat-cache columns parsed into the scorer's diff shape. */
export interface DiffStatCacheInput {
  diffStatCacheCheckedAt: string | null;
  diffStatCacheFilesChanged: number | null;
  diffStatCacheInsertions: number | null;
  diffStatCacheDeletions: number | null;
}

/**
 * Parse a workspace's cached diff-stat columns into the scorer's diff input, or
 * null when the cache has not been populated.
 */
export function parseDiffStatCache(w: DiffStatCacheInput): { filesChanged: number; insertions: number; deletions: number } | null {
  if (!(w.diffStatCacheCheckedAt && w.diffStatCacheFilesChanged !== null)) return null;
  return {
    filesChanged: w.diffStatCacheFilesChanged ?? 0,
    insertions: w.diffStatCacheInsertions ?? 0,
    deletions: w.diffStatCacheDeletions ?? 0,
  };
}

/**
 * For each workspace, count how many OTHER workspaces it shares at least one
 * changed file with. Symmetric pairwise overlap (a workspace contributes at most
 * 1 to another's count regardless of how many files overlap).
 */
export function computeFileOverlapCounts(filesByWs: Map<string, string[]>): Map<string, number> {
  const allWsFiles = [...filesByWs.entries()];
  const overlapCountByWs = new Map<string, number>();
  for (const [wsId, files] of allWsFiles) {
    const fileSet = new Set(files);
    let overlap = 0;
    for (const [otherWsId, otherFiles] of allWsFiles) {
      if (otherWsId === wsId) continue;
      for (const f of otherFiles) {
        if (fileSet.has(f)) {
          overlap++;
          break;
        }
      }
    }
    overlapCountByWs.set(wsId, overlap);
  }
  return overlapCountByWs;
}
