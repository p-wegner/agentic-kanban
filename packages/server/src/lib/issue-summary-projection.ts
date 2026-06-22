import { formatDurationStr, parseSessionStatsBlob } from "@agentic-kanban/shared";

// Pure projection helpers extracted from issue.repository.getIssueSummary. The
// repository fetches rows; these turn the raw session `stats` blob and timestamps
// into the wire shape. Side-effect-free, so they are a directly-unit-testable seam
// (the projection was previously reachable only through a live DB).

export interface IssueSummaryStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string | null;
  success: boolean;
}

/** Parse a session `stats` JSON blob to an object, or null on absent/malformed input. */
export const parseStatsBlob = parseSessionStatsBlob;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

/**
 * Project the parsed stats blob into the summary's `stats` shape, applying the
 * historical defaults (numTurns defaults to 1; model falls back to the parsed
 * session-summary model). Returns null when there is no stats blob.
 */
export function projectSessionStats(
  parsedStats: Record<string, unknown> | null,
  fallbackModel: string | null,
): IssueSummaryStats | null {
  if (!parsedStats) return null;
  const model = parsedStats.model;
  return {
    durationMs: num(parsedStats.durationMs, 0),
    totalCostUsd: num(parsedStats.totalCostUsd, 0),
    inputTokens: num(parsedStats.inputTokens, 0),
    outputTokens: num(parsedStats.outputTokens, 0),
    numTurns: num(parsedStats.numTurns, 1),
    model: typeof model === "string" ? model : fallbackModel,
    success: parsedStats.success === true,
  };
}

/** Format the elapsed time between two ISO timestamps, or null if either is missing. */
export function computeSessionDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  return formatDurationStr(new Date(endedAt).getTime() - new Date(startedAt).getTime());
}
