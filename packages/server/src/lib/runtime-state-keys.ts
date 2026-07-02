// Canonical catalog of the RUNTIME STATE key namespaces that live in the
// `runtime_state` table (ticket #975) — NOT in `preferences` (the closed,
// registry-backed CONFIG set). Single source of truth for:
//   - the 0097 data migration (which namespaces were moved),
//   - the regression guard `runtime-state-separation.test.ts` (preferences must
//     never re-accumulate these keys).
// Keep this list in sync with the WHERE clauses in `0097_runtime_state.sql`.

/** Key prefixes whose full key is `<prefix><suffix>` (suffix = toolUseId / projectId / profile). */
export const RUNTIME_STATE_KEY_PREFIXES = [
  "agent_question_answered_",
  "agent_question_recommendation_",
  // covers both `butler_session_<id>` and `butler_session_history_<id>`
  "butler_session_",
  "agent_profile_launch_failure.",
] as const;

/** Fixed runtime-state keys (no dynamic suffix). */
export const RUNTIME_STATE_EXACT_KEYS = ["backlog_empty_last_run"] as const;

/** TTL for per-question answered/dismissed markers and cached recommendations. These
 *  are keyed by `toolUseId` and grow without bound; a resolved question is only
 *  interesting until its workspace is long gone, so sweep them after this window. */
export const AGENT_QUESTION_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** True when a key belongs to a runtime-state namespace (and thus must NOT be written
 *  to the `preferences` table). */
export function isRuntimeStateKey(key: string): boolean {
  return (
    (RUNTIME_STATE_EXACT_KEYS as readonly string[]).includes(key) ||
    RUNTIME_STATE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
