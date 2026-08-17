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

/**
 * The keys this codebase actually reads out of the blob (#522).
 *
 * It stays a partial, open shape on purpose: the column is untyped JSON written by
 * several code paths across four agent providers, so an exhaustive interface would be a
 * lie the first time a provider adds a field. What this buys is that the ~15 sites which
 * did `JSON.parse(x.stats) as Record<string, unknown>` and then reached for
 * `s.launchFailure` / `s.rateLimitKind` now get a typo caught at compile time instead of
 * silently reading `undefined` — which, for a boolean failure flag, reads as "no failure".
 */
export interface SessionStatsBlob {
  /** The agent never produced substantive output — a launch failure, not a run. */
  launchFailure?: boolean;
  success?: boolean;
  failureReason?: string;
  rateLimited?: boolean;
  rateLimitKind?: "claude-usage-limit" | "codex-usage-limit";
  retryAfter?: string | null;
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  model?: string;
  agentSummary?: string;
  friction?: unknown;
  /** Anything a provider writes that this list has not caught up with yet. */
  [key: string]: unknown;
}

/** `parseSessionStatsBlob(raw) ?? {}` — for the many callers that want an always-object. */
export function readSessionStats(raw: string | null | undefined): SessionStatsBlob {
  return parseSessionStatsBlob(raw) ?? {};
}

/**
 * Read-modify-write of the blob: existing keys survive, the patch wins, and malformed
 * existing JSON is discarded rather than throwing.
 *
 * Pure — it takes the RAW existing value rather than a session id, because the two
 * helpers this replaces (`mergeExistingStats` in session-manager/broadcast.ts and
 * `mergeExistingSessionStats` in session-launch-helpers.ts) had identical bodies but
 * fetched through different data-access paths. Sharing the parse+merge without forcing
 * one of those paths on the other caller is the part that was genuinely duplicated.
 */
export function mergeSessionStats(
  existingRaw: string | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = parseSessionStatsBlob(existingRaw);
  return existing ? { ...existing, ...patch } : patch;
}
