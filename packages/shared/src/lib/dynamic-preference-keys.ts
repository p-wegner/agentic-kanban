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
  // Per-project toolbar curation (#233): a JSON array of ViewMode ids to hide from the toolbar,
  // the "More" overflow, the command palette and the shortcut overlay. `VIEW_REGISTRY` holds 41
  // views and had no hiding mechanism at all — curating the toolbar meant editing the registry
  // and rebuilding, on a board whose whole premise is per-project configuration.
  "hidden_views",
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
  // #613 — was absent from this table for its whole life. It was still ACCEPTED on write,
  // via the dedicated `isBoardStrategyPreferenceKey` predicate OR-ed in beside the table,
  // so the gap was invisible; what it actually cost is that `projectPref` could not be used
  // for it, and eleven sites hand-wrote `board_strategy_${projectId}` instead — including a
  // SECOND deriver in the client. Registering it is what makes the family buildable.
  "board_strategy",
  "board_autodrive",
  "start_mode",
  "board_conductor",
  "conductor_cron",
  "verify_script",
  "cold_clone_check",
  "project_stack_profile",
  "auto_merge_disabled",
  "auto_contract_coupled",
  // Ticket groups (#661): whether the monitor may expand an auto-started issue into a
  // group along its `coupled_with` edges (one workspace serving N tickets). Default ON;
  // "false"/"off" disables per project. See shared/lib/ticket-group.ts.
  "auto_group_coupled",
  // Compounding "setup once" pass (#127): `compounding_setup_<id>` is the per-project
  // gate (`off` | `auto` | a numeric merge threshold); `compounding_setup_state_<id>`
  // holds the JSON record of the pass that already ran, so it runs once, not per ticket.
  "compounding_setup",
  "compounding_setup_state",
  "file_contention",
  // Worker fleet (epic #184): `worker_dispatch_<projectId>` opts a project's builder
  // sessions into remote execution on connected fleet workers ("true"/"false");
  // `worker_labels_<id>` is a CSV of labels a worker must carry; `worker_dispatch_
  // strict_<id>` refuses the host fallback (the monitor then skips the start).
  "worker_dispatch",
  "worker_labels",
  "worker_dispatch_strict",
  // Pre-merge verify-gate timeout override (#192): the runner's wall-clock budget was
  // a hardcoded 5 minutes with no per-project knob, which becomes a hard ceiling as a
  // compiled-stack project's clean build grows past it.
  "verify_timeout_ms",
  // Pre-merge verify-gate vitest worker cap (#278): vitest's `cpus/2` default is
  // tuned for an idle machine, but a gate shares the box with the dev server, other
  // worktrees' gates and the agent — the fan-out then causes the load-dependent
  // timeouts that fail gates and trigger whole-pipeline retries.
  "verify_max_workers",
  "verify_file_scope",
  // Named verify-gate tier (#538): `full | scoped | scoped-base-watch`, replacing three
  // independent booleans (`verify_file_scope` + the implicit package/file scoping an
  // operator could otherwise misalign) with ONE dial. See `resolveVerifyGateStrategy`
  // in `pre-merge-gate.service.ts` for the mapping onto the existing knobs.
  "verify_gate_strategy",
  // #660 — opt-in: run the E2E smoke lane as part of this project's pre-merge gate. Default
  // OFF, because enabling it taxes every merge with ~52s plus a cold two-server boot, and
  // that is an operator's call rather than a default.
  "verify_gate_e2e_smoke",
  // Quiesce builders while a verify gate runs (#581). Measured: raising the gate to 6
  // workers cut the server suite 2380s -> 1564s, and the first gate that then ran WHILE
  // two builders were working failed three real-git `mergeWorkspace` tests that pass in
  // isolation — a load flake indistinguishable from a regression at a glance. Holding new
  // builder STARTS (never killing running ones) for the duration of a gate is the cheapest
  // of #581's options. Default ON; set to "false" to prefer throughput over gate fidelity.
  "quiesce_builders_during_gate",
  // Onboarding plan state (#463): `onboarding_state_<projectId>` holds the JSON record of
  // explicit user skips + a dismissal timestamp — the plan's steps themselves are derived from
  // the world (prefs/columns/issues), never stored, so this is the only piece that needs a key.
  "onboarding_state",
  // #496: live per-project settings with dedicated key builders that were never registered,
  // and the omission had teeth. `getSettings()` filters rows through this allow-list, and
  // config export/import is built on `getSettings()` — so a project's dev command, health
  // url and butler profile were SILENTLY OMITTED from an exported config and REJECTED (422)
  // on the way back in. They are written today only because their own services call
  // `setPreference` directly, bypassing the check.
  "butler_profile",
  "dev_command",
  "health_url",
  // Per-project profile allowlist: a HARD constraint on which provider profiles this
  // project may launch under, applied after every selector (explicit override, Strategy
  // Bullseye, global settings) has had its say. Absent/empty = unrestricted, so this
  // changes nothing until an operator fills it in. See `profile-allowlist.ts` for why
  // this is a separate constraint rather than more Bullseye policies: the Bullseye is a
  // priority list that deliberately falls through on quota, and a per-workspace override
  // outranks it — neither can express "this project may only ever spend account X".
  "allowed_profiles",
  // Multi-repo sibling provisioning (#626/#627). A 17-repo project spends tens of minutes in
  // `provisionSiblingWorktrees` before anything is persisted, and the two halves need
  // different defaults:
  //   - `sibling_install_mode_<id>`: `sequential` (default, today's behaviour) | `parallel`.
  //     Sequential stays the default deliberately — parallel Maven/npm against ONE shared
  //     local cache contends, and that trade-off is the operator's to make per project.
  //   - `sibling_install_timeout_ms_<id>`: per-repo setup timeout. Without it every install
  //     silently inherits DEFAULT_SETUP_SCRIPT_TIMEOUT_MS (5 min); a Maven repo measured at
  //     209 s WARM is uncomfortably close to that from cold.
  // Worktree CREATION is always concurrent and needs no knob — `git worktree add` in repo A
  // constrains nothing in repo B.
  "sibling_install_mode",
  "sibling_install_timeout_ms",
  // Data-handling capability requirement (#876): a CSV of tags (e.g. "no-training,
  // eu-data-residency") the project requires of whichever provider PROFILE a session
  // launches under. Checked against `profile_capabilities_<provider:profile>` (below) —
  // see `profile-capabilities.ts`. Absent/empty = unrestricted, same default-safe shape
  // as `allowed_profiles_<projectId>`.
  "required_data_labels",
  // Merge train batching window (#904/#905): `train_max_size_<id>` caps how many ready
  // workspaces the auto-merge orchestrator collects before releasing them as one train
  // (default 4) — it's also the batching cap `executeQueue` reads to decide whether an
  // eligible independent batch defaults to the train strategy (>1 opts the project in).
  // `train_max_wait_ms_<id>` bounds how long the oldest of them waits regardless of size
  // (default 10 min). Both are read together by `decideMergeTrainRelease` — registering only
  // one would let an operator set a size cap with no wait bound (or vice versa) with no error.
  "train_max_size",
  "train_max_wait_ms",
  // Merge train review (#907): `review_mode_<id>` is `per-ticket` (default) | `per-train` —
  // was a stand-in for the risk-posture resolver before it landed. `per-train` reviews a
  // ticket-group workspace's assembled diff once, with every member's acceptance criteria,
  // instead of reviewing each ticket separately. See server/lib/review-mode-pref.ts.
  "review_mode",
  // Risk posture (#912): `risk_posture_<id>` is one of `strict|standard|fast|sprint`
  // (default `standard`) — the resolver every downstream consumer reads instead of
  // hand-aligning the 8 prefs the proposal names. See shared/lib/risk-posture.ts.
  "risk_posture",
] as const;

// Deliberately NOT registered, though both are per-project keys that exist on disk (#496):
//   - `butler_model_<id>` is LEGACY (see butler-definitions.service.ts): the model moved onto
//     the butler definition and this key survives only as a read fallback for headless
//     callers. Registering it would make a deprecated key writable again via the settings
//     route and MCP — the opposite of retiring it.
//   - `project_completed_announced_<id>` is an internal idempotency marker owned by the
//     completion reconciler, not a user setting. Registering it would surface it in the
//     Settings payload and carry it through config export, where a stale "already announced"
//     flag would suppress the announcement on the importing board.

/**
 * Keys of the form `<prefix>_<suffix>` where the suffix is a free-form name
 * (e.g. a codex/claude profile or license id) rather than a project id.
 */
export const FREEFORM_SUFFIX_KEY_PREFIXES = [
  "codex_cooldown",
  "claude_cooldown",
  // Data-handling capability tags for one PROFILE (#876), suffix `<provider>:<name>`
  // (e.g. "claude:andrena_team_5x_2") — see `profile-capabilities.ts`.
  "profile_capabilities",
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
 * True for a recognized per-project / per-name dynamic preference key. Pure.
 *
 * Since #613 this DOES cover the board-strategy key, because `board_strategy` is finally in
 * the prefix table. Its dedicated predicate below is still OR-ed in by the server service
 * and is deliberately LOOSER (any hex-dash suffix, not the strict UUID shape), so nothing
 * that used to be accepted stopped being accepted.
 */
export function isProjectScopedDynamicKey(key: string): boolean {
  return matchesScopedKey(key, PROJECT_SCOPED_KEY_PREFIXES, (rest) => PROJECT_ID_SUFFIX.test(rest))
    || matchesScopedKey(key, FREEFORM_SUFFIX_KEY_PREFIXES, (rest) => rest.length > 0)
    || isPluginEnabledPreferenceKey(key)
    || isPluginLoopPausedPreferenceKey(key)
    || isPluginLoopConvergedPreferenceKey(key)
    || isPluginOutputLocationPreferenceKey(key);
}

/**
 * True for the per-project plugin enable key (`plugin_enabled_<pluginSlug>_<projectId>`).
 * Two dynamic segments, so it can't ride the single-suffix prefix tables above: the
 * slug is [a-z0-9-]+ (the manifest `id`), the project id the usual UUID shape. The
 * UUID's fixed 8-4-4-4-12 length disambiguates it from the dash-bearing slug.
 */
export function isPluginEnabledPreferenceKey(key: string): boolean {
  return /^plugin_enabled_[a-z0-9-]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
}

/**
 * True for the per-loop pause key (`plugin_loop_paused_<pluginSlug>_<loopName>_<projectId>`).
 * Three dynamic segments — unlike the plugin slug, a loop `name` has no declared
 * charset in the manifest schema, so this can't reuse the strict `[a-z0-9-]+`
 * matcher above. The trailing UUID (fixed 8-4-4-4-12 shape) is unambiguous, so
 * matching is anchored there instead of trying to split slug from loop name.
 */
export function isPluginLoopPausedPreferenceKey(key: string): boolean {
  return /^plugin_loop_paused_.+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
}

/**
 * True for the per-loop convergence key
 * (`plugin_loop_converged_<pluginSlug>_<loopName>_<projectId>`). Same three-dynamic-segment
 * shape as the pause key, anchored on the trailing UUID for the same reason.
 */
export function isPluginLoopConvergedPreferenceKey(key: string): boolean {
  return /^plugin_loop_converged_.+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
}

/**
 * True for the per-project plugin output-location key
 * (`plugin_output_location_<pluginSlug>_<projectId>`). Same two-dynamic-segment
 * shape as `isPluginEnabledPreferenceKey` above, for the same reason.
 */
export function isPluginOutputLocationPreferenceKey(key: string): boolean {
  return /^plugin_output_location_[a-z0-9-]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
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

/** A prefix that is actually registered in the table above. */
export type ProjectScopedPrefix = (typeof PROJECT_SCOPED_KEY_PREFIXES)[number];

/** Build + parse one per-project preference key family. */
export interface ProjectPref {
  readonly prefix: ProjectScopedPrefix;
  /** `<prefix>_<projectId>` */
  key(projectId: string): string;
  /** The project id in `key`, or null when `key` is not of this family. */
  projectIdOf(key: string): string | null;
}

/**
 * A per-project preference key family, built and parsed in one place (#496).
 *
 * ~20 services hand-wrote an `xPrefKey(projectId)` builder and eight more hand-wrote the
 * INVERSE as a bare `/^<prefix>_([0-9a-f-]+)$/` regex, all around a registry table that
 * already listed the prefixes but only for allow-list matching. The two halves could drift
 * from the table and from each other, and the table itself had fallen out of date — three
 * live key families were missing from it entirely (see the note above).
 *
 * Typing `prefix` as `ProjectScopedPrefix` closes that: a family whose prefix is not in
 * `PROJECT_SCOPED_KEY_PREFIXES` is a COMPILE error, so registering a new per-project setting
 * and being able to build/parse its key are no longer two things that can be done separately.
 *
 * `projectIdOf` uses the same `PROJECT_ID_SUFFIX` shape the allow-list matcher uses, so a key
 * this parses is by construction a key `isProjectScopedDynamicKey` accepts.
 */
export function projectPref(prefix: ProjectScopedPrefix): ProjectPref {
  const head = `${prefix}_`;
  return {
    prefix,
    key: (projectId: string) => `${head}${projectId}`,
    projectIdOf: (key: string) => {
      if (!key.startsWith(head)) return null;
      const rest = key.slice(head.length);
      return PROJECT_ID_SUFFIX.test(rest) ? rest : null;
    },
  };
}

/**
 * The Strategy Bullseye key family (#613).
 *
 * CLAUDE.md calls this preference "the single source of truth" for provider selection and
 * monitor tunables, and it was the most hand-written key in the repo: eleven production
 * sites building `board_strategy_${projectId}` inline, plus `settingsKey` in
 * `client/lib/strategy-targets.ts` deriving it a second time. A key with two derivers is a
 * key with two spellings waiting to happen, and the client's copy is the one nothing on the
 * server would catch.
 *
 * Exported as a ready-made family rather than left to each caller's `projectPref(...)` call
 * so the CLIENT can use it too — `client/` cannot import server services, which is exactly
 * why the second deriver existed.
 */
export const boardStrategyPref: ProjectPref = projectPref("board_strategy");
