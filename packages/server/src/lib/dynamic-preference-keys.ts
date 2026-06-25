// Declarative table of per-project (dynamic) preference keys. Project IDs are not
// known ahead of time, so these keys are recognized by a fixed prefix + a suffix
// pattern rather than an exact allow-list. Extracted from preference.service so the
// matcher is pure and unit-testable, and so adding a per-project setting is a
// one-line table edit instead of another hand-written regex (the old form was a
// 22-way `||` chain, CC 23).

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
 * NOT cover the board-strategy key (which the service ORs in via its own
 * normalize-aware predicate); keeping that out keeps this a dependency-free leaf.
 */
export function isProjectScopedDynamicKey(key: string): boolean {
  return matchesScopedKey(key, PROJECT_SCOPED_KEY_PREFIXES, (rest) => PROJECT_ID_SUFFIX.test(rest))
    || matchesScopedKey(key, FREEFORM_SUFFIX_KEY_PREFIXES, (rest) => rest.length > 0);
}
