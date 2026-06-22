// Single source of truth for reading a session's `stats` JSON column.
//
// The `sessions.stats` text column holds a JSON object (token counts, cost,
// duration, friction, agentSummary, …). Parsing it was previously open-coded as
// `JSON.parse(session.stats) as Record<string, unknown>` in ~20 places plus two
// near-identical named helpers (`parseStatsBlob`, `monitor-cycle-rules.parseSessionStats`),
// each re-deriving the same "absent/malformed → empty" guard with slightly different
// return conventions. This is the one parser; typed projections build on top of it.
//
// Pure (no node builtins) so it is safe to re-export from the shared lib barrel.

/**
 * Parse a session `stats` JSON blob into a plain object, or `null` when the input
 * is absent, malformed, or not a JSON object. Callers that prefer an always-object
 * result use `parseSessionStatsBlob(raw) ?? {}`.
 */
export function parseSessionStatsBlob(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
