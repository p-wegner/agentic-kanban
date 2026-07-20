// Declarative table of per-project (dynamic) preference keys. Project IDs are not
// known ahead of time, so these keys are recognized by a fixed prefix + a suffix
// pattern rather than an exact allow-list. Extracted from preference.service so the
// matcher is pure and unit-testable, and so adding a per-project setting is a
// one-line table edit instead of another hand-written regex (the old form was a
// 22-way `||` chain, CC 23).
//
// Lives in @agentic-kanban/shared (moved from packages/server/src/lib, #989) so that
// EVERY preference write path can enforce the same key allow-list — the server route
// (via the re-exporting server module) AND the MCP `set_preference` tool, which used
// to upsert arbitrary keys with no validation. Pure and client-safe: no Node builtins,
// no imports.

/**
 * Keys of the form `<prefix>_<projectId>`, where the project-id suffix is the
 * usual lowercase-hex-with-dashes UUID shape. Add new per-project settings here.
 */
export const PROJECT_SCOPED_KEY_PREFIXES = [
  "butler_event_feed",
  "tdd_mode",
  "backlog_filter_presets",
  "board_saved_views",
  "board_hidden_columns",
  "board_show_priority_legend",
  "board_recent_merges_collapsed",
  "board_card_aging_heatmap",
  "board_aging_warm_days",
  "board_aging_hot_days",
  "launch_templates",
  "agent_presets",
  "monitor_policy_presets",
  "wip_limit",
  "outbound_webhook_url",
  "board_autodrive",
  "start_mode",
  "board_conductor",
  "conductor_cron",
  "verify_script",
  "cold_clone_check",
  "project_stack_profile",
  "auto_merge_disabled",
  "auto_contract_coupled",
  // Compounding "setup once" pass (#127): `compounding_setup_<id>` is the per-project
  // gate (`off` | `auto` | a numeric merge threshold); `compounding_setup_state_<id>`
  // holds the JSON record of the pass that already ran, so it runs once, not per ticket.
  "compounding_setup",
  "compounding_setup_state",
  "file_contention",
] as const;

/**
 * Keys of the form `<prefix>_<suffix>` where the suffix is a free-form name
 * (e.g. a codex/claude profile or license id) rather than a project id.
 */
export const FREEFORM_SUFFIX_KEY_PREFIXES = [
  "codex_cooldown",
  "claude_cooldown",
] as const;

const PROJECT_ID_SUFFIX = /^[0-9a-f-]+$/;

function matchesScopedKey(key: string, prefixes: readonly string[], suffixIsValid: (rest: string) => boolean): boolean {
  for (const prefix of prefixes) {
    const head = `${prefix}_`;
    if (key.startsWith(head) && suffixIsValid(key.slice(head.length))) return true;
  }
  return false;
}

/**
 * True for a recognized per-project / per-name dynamic preference key. Pure — does
 * NOT cover the board-strategy key (which has its own predicate below, and which the
 * server service ORs in via a normalize-aware wrapper).
 */
export function isProjectScopedDynamicKey(key: string): boolean {
  return matchesScopedKey(key, PROJECT_SCOPED_KEY_PREFIXES, (rest) => PROJECT_ID_SUFFIX.test(rest))
    || matchesScopedKey(key, FREEFORM_SUFFIX_KEY_PREFIXES, (rest) => rest.length > 0);
}

/**
 * True for the per-project Strategy Bullseye key (`board_strategy_<projectId>`).
 * Pure and normalize-aware (trim + lowercase), matching the server's
 * `isBoardStrategyKey` in strategy-objective.service.ts, which delegates here so
 * the two can never drift. Its value is a JSON blob and is passed through as-is.
 */
export function isBoardStrategyPreferenceKey(key: string): boolean {
  return /^board_strategy_[0-9a-f-]+$/.test(key.trim().toLowerCase());
}

/**
 * The valid values for a `start_mode_<projectId>` preference — the single
 * per-project Start Mode decision (decision 008). `resolveStartPolicy`
 * (server start-policy.service.ts) builds its VALID_MODES set from this list and
 * SILENTLY falls back to a derived mode for any other value, so writers MUST
 * validate case-sensitively against this list and reject rather than coerce —
 * a case-wrong "Manual" would otherwise be accepted and silently ignored,
 * making the kill-switch ineffective (#989).
 */
export const START_MODE_VALUES = ["manual", "monitor", "conductor"] as const;
