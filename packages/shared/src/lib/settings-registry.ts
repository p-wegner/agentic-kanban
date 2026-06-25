/**
 * SINGLE SOURCE OF TRUTH for the board's global (static) settings keys.
 *
 * Before #903 a new key was a THREE-place edit that drifted constantly:
 *   1. `SETTINGS_KEYS` (server `preference.service.ts`) — the write whitelist,
 *   2. the client `Settings` interface (`settings-shared.ts`),
 *   3. the client `DEFAULT_SETTINGS` object (`settings-shared.ts`).
 * A forgotten entry surfaced as a runtime 422 ("unknown setting key rejected") or,
 * worse, a silently-dropped write (the `auto_rebase_on_continue` / `skip_preflight`
 * bug, #874; the card-aging prefs, #904).
 *
 * Now ALL THREE are DERIVED from this one registry:
 *   - `SETTINGS_KEYS`  = `Object.keys(SETTINGS_REGISTRY)` (+ the dynamic harness keys),
 *   - `DEFAULT_SETTINGS` = `{ [k]: SETTINGS_REGISTRY[k].default }`,
 *   - the `Settings` TS type = `SettingsFromRegistry` (a mapped type over the keys).
 *
 * Because the `Settings` type is the registry's keys, a setting referenced in code
 * that is NOT in the registry is a COMPILE ERROR, not a 422 at runtime. The schema
 * IS the gate.
 *
 * Each entry declares a runtime `type` ("string" | "bool" | "number" | "json") so
 * the typed accessors (`getBool` / `getNumber` / `getJson`) can replace the scattered
 * `=== "true"` / `Number(...)` reads, and a string `default`. Values are persisted as
 * strings in the preferences table; `type` describes how to interpret that string.
 */

export type SettingType = "string" | "bool" | "number" | "json";

export interface SettingDef {
  /** How the persisted string value is interpreted by the typed accessors. */
  type: SettingType;
  /** Default persisted (string) value, surfaced in DEFAULT_SETTINGS. */
  default: string;
}

/**
 * The registry. Add a new GLOBAL static setting here — that single edit derives the
 * whitelist key, the default, and the TS type. (Per-project dynamic keys still go
 * through `dynamic-preference-keys.ts`; per-harness keys through `harness-settings`.)
 */
export const SETTINGS_REGISTRY = {
  agent_command: { type: "string", default: "" },
  agent_args: { type: "string", default: "" },
  output_parser: { type: "string", default: "minimal" },
  skip_permissions: { type: "bool", default: "true" },
  claude_profile: { type: "string", default: "" },
  codex_profile: { type: "string", default: "" },
  pi_profile: { type: "string", default: "" },
  copilot_profile: { type: "string", default: "" },
  provider: { type: "string", default: "claude" },
  default_model_claude: { type: "string", default: "" },
  default_model_codex: { type: "string", default: "" },
  default_model_pi: { type: "string", default: "" },
  mock_agent_profile: { type: "string", default: "" },
  mock_agent_delay_ms: { type: "number", default: "" },
  permission_prompt_tool: { type: "bool", default: "false" },
  auto_review: { type: "bool", default: "true" },
  auto_merge: { type: "bool", default: "true" },
  auto_merge_in_review: { type: "bool", default: "false" },
  resume_with_new_model: { type: "bool", default: "false" },
  review_auto_fix: { type: "bool", default: "true" },
  disabled_mcp_tools: { type: "string", default: "" },
  auto_start_followup: { type: "bool", default: "false" },
  require_manual_approval: { type: "bool", default: "false" },
  auto_rebase_on_continue: { type: "bool", default: "false" },
  skip_preflight: { type: "bool", default: "false" },
  dependency_auto_chain: { type: "bool", default: "false" },
  coupling_overlap_threshold: { type: "number", default: "0.5" },
  coupling_contract_min_size: { type: "number", default: "2" },
  dynamic_column_scaling: { type: "bool", default: "false" },
  card_density: { type: "string", default: "" },
  persistent_agent: { type: "bool", default: "false" },
  learning_step_after_agent: { type: "bool", default: "false" },
  learning_step_after_review: { type: "bool", default: "false" },
  learning_step_before_merge: { type: "bool", default: "false" },
  auto_monitor: { type: "bool", default: "false" },
  auto_monitor_interval: { type: "number", default: "4" },
  nudge_auto_start: { type: "bool", default: "false" },
  nudge_wip_limit: { type: "number", default: "" },
  projects_base_path: { type: "string", default: "" },
  plan_auto_continue: { type: "bool", default: "true" },
  visual_verification_mode: { type: "string", default: "before_merge" },
  after_merge_verify_agent: { type: "string", default: "" },
  builder_guardrails: { type: "string", default: "" },
  backup_interval_min: { type: "number", default: "" },
  backup_keep_last: { type: "number", default: "" },
  butler_event_feed: { type: "bool", default: "false" },
  butler_event_feed_min_interval_ms: { type: "number", default: "30000" },
  butler_auto_answer: { type: "bool", default: "false" },
  butler_auto_answer_min_confidence: { type: "number", default: "" },
  monitor_butler_enabled: { type: "bool", default: "false" },
  monitor_butler_interval_min: { type: "number", default: "" },
  monitor_maintenance_window_enabled: { type: "bool", default: "false" },
  monitor_maintenance_window_end: { type: "string", default: "" },
  backlog_empty_strategy: { type: "string", default: "skip" },
  backlog_empty_skill: { type: "string", default: "architecture-improvement" },
  backlog_empty_cooldown_min: { type: "number", default: "120" },
  backlog_empty_last_run: { type: "string", default: "" },
  backlog_stale_days: { type: "number", default: "14" },
  inprogress_stale_days: { type: "number", default: "3" },
  stale_column_threshold_days: { type: "number", default: "" },
  auto_commit_strategy_objective: { type: "bool", default: "true" },
  merge_strategy: { type: "string", default: "" },
  issue_templates: { type: "json", default: "" },
  export_skills_on_registration: { type: "bool", default: "" },
  codex_license_ring: { type: "json", default: "" },
  codex_license_rotation: { type: "bool", default: "true" },
  claude_subscription_ring: { type: "json", default: "" },
  claude_subscription_rotation: { type: "bool", default: "true" },
} as const satisfies Record<string, SettingDef>;

/** Union of the registry's static setting keys. */
export type SettingKey = keyof typeof SETTINGS_REGISTRY;

/**
 * Per-harness `plan_auto_continue` keys (`harness.<harness>.plan_auto_continue`).
 * Static, finite, and known at compile time, so they belong in the `Settings` type
 * even though their RUNTIME whitelist contribution is produced by
 * `allHarnessSettingKeys()` (server-only — it lives next to the harness defaults).
 */
export type HarnessSettingKeyName =
  | "harness.claude.plan_auto_continue"
  | "harness.codex.plan_auto_continue"
  | "harness.copilot.plan_auto_continue"
  | "harness.pi.plan_auto_continue";

/**
 * The `Settings` type, DERIVED from the registry keys (+ the harness keys). Every
 * value is `string | undefined` because preferences persist as strings and a key may
 * be absent. Adding a key to `SETTINGS_REGISTRY` automatically widens this type; a
 * setting key referenced in code but missing from the registry is a compile error.
 */
export type Settings = {
  [K in SettingKey | HarnessSettingKeyName]?: string;
};

/** The ordered list of static registry keys (the write/read whitelist core). */
export const SETTINGS_REGISTRY_KEYS: SettingKey[] = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

/**
 * DEFAULT_SETTINGS — DERIVED from the registry. Only keys with a non-empty default
 * are emitted (an empty string default is the absence of a default, matching the old
 * hand-written object which omitted such keys).
 */
export const DEFAULT_SETTINGS: Settings = (() => {
  const out: Settings = {};
  for (const key of SETTINGS_REGISTRY_KEYS) {
    const def = SETTINGS_REGISTRY[key];
    if (def.default !== "") out[key] = def.default;
  }
  return out;
})();

type PrefSource = Map<string, string> | Record<string, string>;

function readRaw(source: PrefSource, key: string): string | undefined {
  return source instanceof Map ? source.get(key) : source[key];
}

/**
 * Typed accessors — read a persisted string preference as the type the registry
 * declares for it, replacing the scattered `=== "true"` / `Number(...)` / `JSON.parse`
 * reads. They take the raw key (string) so callers that already hold a dynamic key can
 * use them; for registry keys the key is type-checked at the call site via `SettingKey`.
 */

/** Boolean read: a value is true unless it is the literal string "false" (and present). */
export function getBool(source: PrefSource, key: string, fallback = false): boolean {
  const raw = readRaw(source, key);
  if (raw === undefined || raw === "") return fallback;
  return raw !== "false";
}

/** Numeric read: parses the string; returns `fallback` when absent or unparseable. */
export function getNumber(source: PrefSource, key: string, fallback = 0): number {
  const raw = readRaw(source, key);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** JSON read: parses the string; returns `fallback` when absent or invalid JSON. */
export function getJson<T>(source: PrefSource, key: string, fallback: T): T {
  const raw = readRaw(source, key);
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
