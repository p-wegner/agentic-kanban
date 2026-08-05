/**
 * Derived IDENTIFIERS of the plugin system: the preference keys, the loop dedupe key, and the
 * output-location vocabulary. Split out of `plugin-manifest.ts` when that module tripped the
 * cohesion half of the god-module gate (#889) — every function here is a pure string derivation
 * with no relationship to manifest PARSING, which is what the rest of that file is about.
 *
 * Re-exported unchanged through `plugin-manifest.ts`, so every existing
 * `@agentic-kanban/shared/lib/plugin-manifest` import keeps working; that facade is the documented
 * contract (docs/plugin-development.md) and this file is an implementation detail of it.
 *
 * Pure strings, no Node builtins — client-safe through the shared lib barrel.
 */

/**
 * Dedupe key stamped onto every ticket a loop advance creates, and matched
 * against on the next advance so a still-outstanding unit is never re-ticketed.
 * Kept in the shared lib so the server (which writes it) and any consumer that
 * needs to recognise loop tickets derive it identically.
 *
 * The key is `:`-joined, so both leading segments must be colon-free for the join to be
 * unambiguous: the slug is `PLUGIN_ID_PATTERN` and the loop name `PLUGIN_LOOP_NAME_PATTERN`
 * (#250). Unit ids are deliberately unconstrained — they are the planner's own composite
 * ("billing:round-3") and only ever the TAIL.
 *
 * KNOWN DEBT (#201): this key rides on `issues.externalKey`, a column documented
 * (and rendered in the UI) as a genuine external-tracker link — not a private
 * board-internal dedupe carrier. Works today because the prefix is namespaced and
 * no loop ticket sets `externalUrl`, but a second "machine-created, dedupe on
 * re-run" feature should get its own nullable `source_key` column rather than
 * reuse this one.
 */
export function pluginLoopUnitKey(pluginSlug: string, loopName: string, unitId: string): string {
  return `plugin-loop:${pluginSlug}:${loopName}:${unitId}`;
}

/**
 * The name a `skills[].dir` is known by everywhere else: its basename.
 *
 * ONE derivation, because three hand-rolled ones disagreed: `runSkill` matched
 * `dir.split("/").pop()`, the butler roster used `split(/[\\/]/).filter(Boolean).pop()`, and the
 * fan-out used `path.basename`. A dir written `".claude/skills/x/"` therefore appeared in the
 * roster as `x` and was unlaunchable (`pop()` returned `""`). The parser now also rejects the
 * trailing slash, so this is belt and braces — but the sites must still agree.
 */
export function pluginSkillName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** The per-project enable pref key for a plugin: `plugin_enabled_<pluginSlug>_<projectId>`. */
export function pluginEnabledPreferenceKey(pluginSlug: string, projectId: string): string {
  return `plugin_enabled_${pluginSlug}_${projectId}`;
}

/**
 * Per-loop pause pref key. Explicit and per-loop (not per-plugin) since a plugin
 * can offer several independent loops — pausing one must not stop the others.
 * Checked by `advanceDuePluginLoops` (the monitor's auto-advance pass); a human
 * pressing "Advance now" on a paused loop still works, since pause only stops the
 * hands-off convergence, not deliberate manual action.
 */
export function pluginLoopPausedPreferenceKey(pluginSlug: string, loopName: string, projectId: string): string {
  return `plugin_loop_paused_${pluginSlug}_${loopName}_${projectId}`;
}

/**
 * Per-loop CONVERGENCE pref key — the planner's terminal verdict, persisted.
 *
 * Convergence used to be reported and thrown away: a loop whose tickets were all closed and
 * whose planner reported "nothing left to do" was replanned on EVERY monitor cycle, forever, so a
 * board with several finished loops paid one planner subprocess per loop per cycle and only an
 * explicit pause stopped it. The flag is written by an advance whose plan reported no units AND
 * `converged: true`, and cleared by any advance that plans units again — so a human pressing
 * "Advance now" (which never consults the flag) is the restart path.
 *
 * Deliberately NOT the same key as pause: pause is a human decision the UI must keep showing as
 * such, convergence is the loop's own terminal state. Collapsing them would make "resume" mean
 * two different things.
 */
export function pluginLoopConvergedPreferenceKey(pluginSlug: string, loopName: string, projectId: string): string {
  return `plugin_loop_converged_${pluginSlug}_${loopName}_${projectId}`;
}

/**
 * Where a plugin's scaffold/script/loop output (e.g. extracted requirements docs)
 * is written for a project:
 * - `"leading"` — the project's leading repo. Default for every project; for a
 *   single-repo project this IS "inside the repo" (there is nothing else to pick).
 * - `"sidecar"` — a dedicated repo of its own, named after the plugin
 *   (`pluginSidecarRepoName`), added to the project's repo set. Meaningful mainly
 *   for multi-repo projects that want extraction output kept out of every
 *   product repo, but available regardless of repo count.
 */
export type PluginOutputLocation = "leading" | "sidecar";

export const PLUGIN_OUTPUT_LOCATIONS: readonly PluginOutputLocation[] = ["leading", "sidecar"];

export const DEFAULT_PLUGIN_OUTPUT_LOCATION: PluginOutputLocation = "leading";

export function isPluginOutputLocation(value: unknown): value is PluginOutputLocation {
  return value === "leading" || value === "sidecar";
}

/** The per-project output-location pref key: `plugin_output_location_<pluginSlug>_<projectId>`. */
export function pluginOutputLocationPreferenceKey(pluginSlug: string, projectId: string): string {
  return `plugin_output_location_${pluginSlug}_${projectId}`;
}

/** Repo name a `"sidecar"`-mode plugin's dedicated repo is looked up / created under. */
export function pluginSidecarRepoName(pluginSlug: string): string {
  return `${pluginSlug}-requirements`;
}
