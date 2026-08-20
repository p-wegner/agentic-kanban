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

/**
 * The providers whose quota exhaustion the board parks a workspace on (#542).
 *
 * The blob has carried a discriminant (`rateLimitKind`) all along, but every reader was a
 * per-provider predicate — `isCodexUsageLimitStats` / `isClaudeUsageLimitStats`, identical
 * except for the literal — and every consumer then OR'd the pair, or picked one ad hoc.
 * Reading the discriminant once gives callers the provider for free, which is what the
 * per-provider predicates were throwing away.
 */
export const USAGE_LIMIT_KINDS = ["codex", "claude"] as const;
export type UsageLimitKind = (typeof USAGE_LIMIT_KINDS)[number];

const RATE_LIMIT_KIND_BY_PROVIDER: Record<UsageLimitKind, "codex-usage-limit" | "claude-usage-limit"> = {
  codex: "codex-usage-limit",
  claude: "claude-usage-limit",
};

/** What a usage-limit death recorded: which provider, and its own reset time if it gave one. */
export interface UsageLimitStats {
  kind: UsageLimitKind;
  /** The provider's reset time (ISO), or null when it named none. */
  retryAfter: string | null;
}

/**
 * Read a session's persisted stats as a usage-limit death, or null when it is not one.
 *
 * Returns the provider so a caller no longer has to ask each predicate in turn, and the
 * reset time so it is parsed once rather than re-read from the blob afterwards.
 */
export function readUsageLimitStats(raw: string | null | undefined): UsageLimitStats | null {
  const stats = parseSessionStatsBlob(raw);
  if (!stats || stats.rateLimited !== true) return null;
  const kind = USAGE_LIMIT_KINDS.find((k) => stats.rateLimitKind === RATE_LIMIT_KIND_BY_PROVIDER[k]);
  if (!kind) return null;
  return { kind, retryAfter: typeof stats.retryAfter === "string" ? stats.retryAfter : null };
}

/** True when the stats record a usage-limit death by THIS provider. */
export function isUsageLimitStatsOf(raw: string | null | undefined, kind: UsageLimitKind): boolean {
  return readUsageLimitStats(raw)?.kind === kind;
}

export interface UsageLimitStatsInput {
  executor: string;
  durationMs: number;
  exitCode: number | null;
  message: string;
  /** The provider's reset time, persisted so the exit rotation can stamp the cooldown window. */
  retryAfter: string | null;
}

/**
 * The stats blob written when a session dies on a provider quota. One builder keyed on the
 * provider; the two it replaces were identical but for the `rateLimitKind` literal.
 */
export function buildUsageLimitStats(kind: UsageLimitKind, input: UsageLimitStatsInput): SessionStatsBlob & { failureReason: string } {
  return {
    durationMs: input.durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: input.executor,
    success: false,
    launchFailure: true,
    rateLimited: true,
    rateLimitKind: RATE_LIMIT_KIND_BY_PROVIDER[kind],
    retryAfter: input.retryAfter,
    failureReason: input.message,
    providerExitCode: input.exitCode,
    agentSummary: input.message,
  };
}
