/**
 * Which session represents an issue — the one policy, shared (#506).
 *
 * This used to live only in the server (`services/session-filter.ts` +
 * `lib/issue-cli-format.ts`), so the CLI applied it and the REST repository and the MCP
 * `get_issue_summary` tool did not: both took `find(completed|stopped) ?? rows[0]` and
 * would happily summarize a board-monitor session as if it were the agent's work on the
 * ticket. Moving it here lets all three surfaces call `loadIssueSummary` and get the same
 * answer. The server modules re-export these names, so their existing importers are
 * unchanged.
 */

/** Trigger types whose sessions should not count as real implementation work. */
export const NOISE_TRIGGER_TYPES: readonly string[] = [
  "skill:board-monitor",
  "skill:board-navigator",
];

const NOISE_TRIGGER_SET = new Set<string>(NOISE_TRIGGER_TYPES);

/**
 * Returns true if the session is analytics noise and should be excluded from
 * retry counts, success metrics, and the "latest session" display.
 */
export function isAnalyticsNoise(session: { triggerType?: string | null }): boolean {
  const t = session.triggerType;
  if (!t) return false;
  return NOISE_TRIGGER_SET.has(t);
}

/**
 * Pick the session to summarize: prefer non-noise sessions, then the first
 * completed/stopped one, falling back to the most recent (input is desc by
 * startedAt). Pure given the noise predicate.
 *
 * Note the fallback: when EVERY session is noise, the noise set is used rather than
 * returning null — an issue whose only session was a board-monitor pass still reports
 * something instead of claiming "no session".
 */
export function selectSummarySession<T extends { status: string }>(
  sessionRows: T[],
  isNoise: (s: T) => boolean,
): T | null {
  const nonNoise = sessionRows.filter((s) => !isNoise(s));
  const relevant = nonNoise.length > 0 ? nonNoise : sessionRows;
  return relevant.find((s) => s.status === "completed" || s.status === "stopped") ?? relevant[0] ?? null;
}
