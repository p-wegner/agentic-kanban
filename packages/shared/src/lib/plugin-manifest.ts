/**
 * Plugin manifest contract (`kanban-plugin.json` at the plugin repo root).
 *
 * Pure string/JSON logic — no Node builtins — so it is client-safe through the
 * shared lib barrel: the client imports these types (and can re-validate a
 * manifest blob) without pulling anything server-only into the bundle. Reading
 * the manifest FILE from disk is the server's job (plugin.service.ts).
 *
 * Example manifest:
 * ```json
 * {
 *   "id": "refactor-safety-net",
 *   "name": "Refactor Safety Net",
 *   "version": "0.1.0",
 *   "skills": [{ "dir": ".claude/skills/requirement-extraction", "init": true }],
 *   "views": [{ "id": "coverage", "label": "Coverage", "kind": "iframe",
 *               "serve": { "command": "node tools/coverage/serve.mjs", "portEnv": "PORT",
 *                          "healthPath": "/health",
 *                          "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "scripts": [{ "name": "coverage", "command": "npm run coverage", "cwd": "plugin",
 *                 "env": { "SOURCE_ROOT": "{{leadingRepoPath}}", "COVERAGE_ROOT": "{{repoPath}}" } }],
 *   "loops": [{ "name": "requirement-extraction", "skill": "requirement-extraction",
 *               "plan": { "command": "node tools/loop-plan.mjs --json", "cwd": "plugin",
 *                         "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "butler": { "promptFragment": "butler-fragment.md" },
 *   "scaffold": { "profileTemplate": "profile-template.md",
 *                 "targetPath": "docs/analysis/_project-profile.md" }
 * }
 * ```
 */

/**
 * The derived identifiers (pref keys, the loop dedupe key, output-location vocabulary) live in
 * `plugin-keys.ts` and are re-exported here: this module is the documented import path for the
 * whole contract, and splitting them out was a cohesion fix, not an API change. Import either.
 */
import {
  PLUGIN_MANIFEST_FILENAME, PluginManifestError, asRecord, fail, optionalCwd, optionalEnv, optionalString,
  requireArray, requireRelativePath, requireString, type PluginCwd,
} from "./plugin-manifest-fields.js";
export { PLUGIN_MANIFEST_FILENAME, PluginManifestError };
export type { PluginCwd };
import type { PluginLoopPlanDef } from "./plugin-manifest-loop-plan.js";
export {
  parsePluginLoopPlan, PLUGIN_PROGRESS_STATES, PLUGIN_CHECK_VERDICTS, DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE,
} from "./plugin-manifest-loop-plan.js";
export type {
  PluginLoopPlanDef, PluginLoopUnit, PluginLoopGateAction, PluginLoopGate, PluginProgressState,
  PluginLoopProgressStep, PluginCheckVerdict, PluginLoopCheck, PluginLoopPlan,
} from "./plugin-manifest-loop-plan.js";

import { errorMessage } from "./error-message.js";
import { isSkillListing, SKILL_LISTINGS, type SkillListing } from "./plugin-skill-listing.js";

export {
  pluginLoopUnitKey,
  parsePluginLoopUnitKey,
  pluginSkillName,
  pluginEnabledPreferenceKey,
  pluginLoopPausedPreferenceKey,
  pluginLoopConvergedPreferenceKey,
  pluginOutputLocationPreferenceKey,
  pluginSidecarRepoName,
  isPluginOutputLocation,
  PLUGIN_OUTPUT_LOCATIONS,
  DEFAULT_PLUGIN_OUTPUT_LOCATION,
  pluginSyncConfigPreferenceKey,
  pluginSyncStatusPreferenceKey,
  pluginSyncSecretsPreferenceKey,
} from "./plugin-keys.js";
export type { PluginOutputLocation } from "./plugin-keys.js";
// …and used here, so the parser's own skill-name derivation is the same one every consumer uses.
import { pluginSkillName } from "./plugin-keys.js";

/** Valid plugin slug: lowercase alphanumerics and dashes. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Valid loop `name`: letters, digits, `.`, `_`, `-` — and notably NO `:` (#250).
 *
 * The loop name is a SEGMENT of the `:`-joined dedupe key (`pluginLoopUnitKey`), and unit ids
 * legitimately contain colons (`billing:round-3` is the documented retry shape). If a loop name
 * could contain one too, loop `a` + unit `b:c` and loop `a:b` + unit `c` would produce the same
 * key, so one loop's unit would be read as "already ticketed" by the other and silently never
 * ticketed. Constraining the name — not the unit ids — makes the split unambiguous while leaving
 * planners free to compose ids. Whitespace and `%`/`\` are excluded for the same reason the LIKE
 * prefix is escaped: a name that is also a pattern is a name that matches the wrong rows.
 */
export const PLUGIN_LOOP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Who an entry is FOR (#456) — the board's capability rail renders the two differently.
 *
 * `operator` (the default, and what every pre-#456 manifest gets) is workflow: the things a
 * person running this pipeline presses. `developer` is diagnostics — a selftest over the
 * plugin's own fixtures, a dry-run planner dump, a skill the LOOP launches so pressing it by
 * hand duplicates loop work. Both are still reachable; the rail just collapses `developer`
 * entries under a "Diagnostics" disclosure so a seven-entry rail stops presenting five
 * debugging tools at the same weight as the one entry that is the actual job.
 */
export const PLUGIN_AUDIENCES = ["operator", "developer"] as const;
export type PluginAudience = (typeof PLUGIN_AUDIENCES)[number];

/** The audience an entry gets when its manifest says nothing — backward compatibility. */
export const DEFAULT_PLUGIN_AUDIENCE: PluginAudience = "operator";

export interface PluginSkillDef {
  /** Directory inside the plugin repo containing a SKILL.md (e.g. ".claude/skills/x"). */
  dir: string;
  /** One-line "what this skill does", surfaced next to its Run button. */
  description?: string;
  /**
   * Default workflow template for tickets launched from this skill — a builtin key
   * (`research-task`, `simple-ticket`, …) or a template name. Optional, and only a DEFAULT:
   * the launcher can always pick another in the UI.
   *
   * It exists because the plugin author knows something the board cannot infer. A mining
   * round that only writes analysis docs has nothing for a code reviewer to review, so
   * sending it through implement → review → done makes every round wait on a gate that can
   * only rubber-stamp it. Without this field the board's per-issue-type default silently wins.
   */
  workflow?: string;
  /** Who this skill is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  /**
   * Marks this as the plugin's ENTRY skill for a codebase that has never used the plugin
   * before (#462) — e.g. refactor-safety-net's API-documentation skill, which must run
   * once against a fresh project before the plugin's other skills produce useful output.
   * The board cannot infer this; only the plugin author knows which skill is the on-ramp.
   * Optional and absent by default, so a pre-#462 manifest keeps parsing unchanged.
   */
  init?: boolean;
  /**
   * How this skill should be LISTED to the model when the board materializes it (#1251) — a
   * hint from the plugin author, e.g. `on` for a skill agents must find by its description. The
   * project override still wins; absent, the board-wide `plugin_skill_listing_default` applies.
   */
  listing?: SkillListing;
}

export interface PluginViewServeDef {
  /** Shell command that starts the view's HTTP server. */
  command: string;
  /** Where the command runs. Default "plugin" — a view server ships with the plugin. */
  cwd?: PluginCwd;
  /** Env var name the server reads its port from (e.g. "PORT"). */
  portEnv?: string;
  /**
   * Path the readiness probe requests instead of "/". Default "/health"; a 404 there falls
   * back to probing "/" (so existing plugins with no dedicated endpoint keep working).
   * Prefer a cheap, dependency-free endpoint — the probe runs on every status check.
   */
  healthPath?: string;
  /** Extra env vars; values support {{repoPath}}/{{leadingRepoPath}}/{{projectName}}/{{pluginPath}}/{{port}}/{{boardUrl}}/{{projectId}}. */
  env?: Record<string, string>;
}

export interface PluginViewDef {
  id: string;
  label: string;
  /** Only "iframe" is supported in this slice. */
  kind: "iframe";
  description?: string;
  /** Who this view is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  serve: PluginViewServeDef;
}

export interface PluginScriptDef {
  name: string;
  /** Shell command. */
  command: string;
  /** Human-facing name for the UI; falls back to `name`. */
  label?: string;
  description?: string;
  /** Where the command runs: the plugin's own checkout or the project repo. Default "repo". */
  cwd?: PluginCwd;
  /** Who this script is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  /** Extra env vars; values support the same placeholders as view env. */
  env?: Record<string, string>;
}

/**
 * A converging, board-OWNED analysis loop.
 *
 * The plugin contributes only judgment-free state: `plan` is a deterministic
 * command that prints the work units still outstanding (JSON). The BOARD owns
 * everything else — it turns each unit into a ticket carrying the loop's skill,
 * and its own monitor starts them within the project's WIP limit, under the
 * Strategy Bullseye's provider selection and the auth-rotation ring (so a
 * quota-exhausted profile rotates mid-loop), through the normal review/merge
 * gates.
 *
 * What stops a loop: a plan reporting NO units and `converged: true`. That verdict is
 * PERSISTED per project (`pluginLoopConvergedPreferenceKey`) and the monitor then stops
 * advancing the loop, so the planner is not re-run forever. `units: [], converged: false`
 * is the deliberate "blocked, not done" state — the monitor keeps checking it.
 *
 * This is deliberately NOT a plugin-side agent runner: work that spawns agents
 * belongs on the board, where it is visible, governed, and resumable.
 */
export interface PluginLoopDef {
  name: string;
  /** Human-facing name for the UI; falls back to `name`. */
  label?: string;
  description?: string;
  /** Skill (a `skills[].dir` basename) each generated ticket is launched with. */
  skill: string;
  /** Deterministic command printing the outstanding work units as JSON. */
  plan: PluginLoopPlanDef;
  /**
   * Default workflow template for the tickets this loop creates (builtin key or name).
   * Falls back to the loop's skill's `workflow`, then to the board's default. Same reason as
   * `PluginSkillDef.workflow` — and it matters more here, because a loop creates tickets in
   * bulk with no human at the keyboard to pick one.
   */
  workflow?: string;
  /**
   * Safety stop: refuse to create more than this many tickets for one advance.
   * Defaults to `DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE`.
   */
  maxUnitsPerAdvance?: number;
  /**
   * Opt-in auto-land (#297): when a ticket this loop created finishes with committed
   * changes, the board merges its workspace automatically (still through the pre-merge
   * gate) instead of parking it at In Review until someone enables the global
   * `auto_merge_in_review` pref. For a document-producing loop the merge is what makes
   * the artifact visible to the planner (it reads the MAIN checkout), so without this
   * every round stalls on a human pressing Merge. Default false — landing product code
   * without review remains a deliberate, per-loop authorial decision.
   */
  autoLand?: boolean;
  /**
   * Opt-in: the loop's tickets follow the plan, not just the other way round (#1643).
   * (1) A unit whose ticket is Done/Cancelled but which the plan STILL reports is not left as a
   * silent skip: the board opens the next round (`…:r1` -> `…:r2`) so the loop cannot dead-end.
   * (2) An open, not-running ticket whose unit has left the plan (its cause went away) is closed
   * with a comment. Off by default: most loops mint their own fresh ids and never drop a unit
   * they are still working on.
   */
  reconcileUnits?: boolean;
}

/**
 * A plugin-authored page the board shows in the Plugins menu (e.g. an overview of how the
 * plugin's parts fit together and when to reach for which). Served from the plugin's
 * checkout by the board (`GET /api/plugins/:id/docs/:file`) — the board itself carries no
 * knowledge of any particular plugin, so a board without the plugin lists nothing.
 */
export interface PluginDocDef {
  /** Path (relative to the plugin root) of an .html or .md file. */
  file: string;
  /** Menu label. */
  title: string;
  description?: string;
  audience?: PluginAudience;
}

/** Valid `sync.provider` id: lowercase alphanumerics and dashes, same shape as the plugin id. */
export const PLUGIN_SYNC_PROVIDER_PATTERN = /^[a-z0-9-]+$/;

/** One command the plugin exposes for the sync direction (same shape as a script). */
export interface PluginSyncCommandDef {
  /** Shell command. */
  command: string;
  /** Where the command runs. Default "plugin". */
  cwd?: PluginCwd;
  /** Extra env vars; values support the same placeholders as script env. */
  env?: Record<string, string>;
}

/**
 * One field of the sync provider's configuration (site URL, project key, JQL, …) — declared so
 * the board can render a form instead of the plugin author hand-rolling one per provider.
 */
export interface PluginSyncConfigFieldDef {
  /** Stable key the resolved value is stored/passed under. */
  key: string;
  label?: string;
  description?: string;
  /** Default false — a field the board may leave empty. */
  required?: boolean;
  /** Input kind for the settings form (#1630); values are still stored as strings. Default "text". */
  type?: PluginSyncConfigFieldType;
  /** The allowed values of a `select` field (the settings form renders a dropdown; empty stays allowed). */
  options?: string[];
}

export const PLUGIN_SYNC_CONFIG_FIELD_TYPES = ["text", "boolean", "number", "json", "select"] as const;
export type PluginSyncConfigFieldType = (typeof PLUGIN_SYNC_CONFIG_FIELD_TYPES)[number];

/**
 * Declarative external-issue-tracker sync capability (#1076).
 *
 * The manifest never carries secret VALUES — only the NAMES of secret references the board
 * resolves at run time (e.g. an entry in its own credential store) and injects as env vars into
 * `pull`/`push`. A manifest that put a token inline would leak it into the plugin repo (source
 * control) and the board's own `plugins` row; naming a reference keeps the secret wherever the
 * operator already keeps it.
 */
export interface PluginSyncDef {
  /** Stable id of the external tracker this plugin syncs with (e.g. "jira", "linear"). */
  provider: string;
  /** Deterministic command pulling remote state into the project. At least one of pull/push is required. */
  pull?: PluginSyncCommandDef;
  /** Deterministic command pushing local state to the remote tracker. At least one of pull/push is required. */
  push?: PluginSyncCommandDef;
  /**
   * Optional command that settles ONE diverged issue on request (#1643): the board runs it with the
   * sync credentials injected plus `SYNC_RESOLVE_KEY` and, to act, `SYNC_RESOLVE_KEEP=board|jira`
   * (no KEEP = read-only show). It exists so an agent without credentials can still resolve a
   * conflict, through the board.
   */
  resolve?: PluginSyncCommandDef;
  /** Config fields the board should collect before running pull/push (site URL, project key, JQL, …). */
  config?: PluginSyncConfigFieldDef[];
  /**
   * Names of secret references this sync needs (e.g. "JIRA_API_TOKEN") — never the secret
   * values themselves. The board resolves each name against its own credential store and injects
   * it as an env var when running `pull`/`push`.
   */
  secrets?: string[];
}

export type {
  PluginPlaceholderVars,
} from "./plugin-placeholders.js";
export {
  PLUGIN_PLACEHOLDER_KEYS,
  buildPluginPlaceholderVars,
  substitutePluginPlaceholders,
  substitutePluginEnv,
} from "./plugin-placeholders.js";

export interface PluginManifest {
  /** Unique slug ([a-z0-9-]+); doubles as the install directory name and pref-key segment. */
  id: string;
  name: string;
  version?: string;
  /** One-paragraph "what this plugin is for", shown in Settings → Plugins. */
  description?: string;
  skills?: PluginSkillDef[];
  views?: PluginViewDef[];
  scripts?: PluginScriptDef[];
  loops?: PluginLoopDef[];
  docs?: PluginDocDef[];
  /** Declarative external-issue-tracker sync capability (#1076). Absent = no back-compat change. */
  sync?: PluginSyncDef;
  butler?: {
    /** Path (relative to the plugin root) of a markdown fragment appended to the butler prompt. */
    promptFragment: string;
  };
  scaffold?: {
    /** Path (relative to the plugin root) of the template to write into the project. */
    profileTemplate: string;
    /** Path (relative to the project repo root) the template is written to, if absent. */
    targetPath: string;
  };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") fail(`"${field}" must be a boolean`);
  return value;
}

/**
 * `audience` is optional and absence is meaningful: it means "operator", so a manifest written
 * before #456 keeps rendering exactly as it did. It is left UNDEFINED here rather than
 * defaulted, so a consumer can still tell "unset" from "explicitly operator"; every renderer
 * resolves it through `DEFAULT_PLUGIN_AUDIENCE`.
 */
function optionalAudience(value: unknown, field: string): PluginAudience | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !(PLUGIN_AUDIENCES as readonly string[]).includes(value)) {
    fail(`"${field}" must be one of ${PLUGIN_AUDIENCES.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as PluginAudience;
}

/**
 * Parse + validate a `kanban-plugin.json` blob. Accepts the raw JSON text or an
 * already-parsed object; throws `PluginManifestError` with a field-precise
 * message on any violation. Unknown top-level fields are ignored (forward compat).
 */
// `input: unknown` — it used to read `string | unknown`, which TypeScript collapses to
// `unknown` anyway (no-redundant-type-constituents). The string case is handled below.
export function parsePluginManifest(input: unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      fail(`not valid JSON — ${errorMessage(err)}`);
    }
  }
  const obj = asRecord(raw, "manifest");

  const id = requireString(obj.id, "id");
  if (!PLUGIN_ID_PATTERN.test(id)) fail(`"id" must match ${PLUGIN_ID_PATTERN} (got "${id}")`);
  const name = requireString(obj.name, "name");
  const version = optionalString(obj.version, "version");
  const description = optionalString(obj.description, "description");

  const skills = obj.skills == null ? undefined : requireArray(obj.skills, "skills").map((entry, i) => {
    const rec = asRecord(entry, `skills[${i}]`);
    return {
      dir: requireRelativePath(rec.dir, `skills[${i}].dir`),
      description: optionalString(rec.description, `skills[${i}].description`),
      workflow: optionalString(rec.workflow, `skills[${i}].workflow`),
      audience: optionalAudience(rec.audience, `skills[${i}].audience`),
      init: optionalBoolean(rec.init, `skills[${i}].init`),
      // #1251 — inline rather than a helper: this module sits at the god-module cohesion ceiling.
      listing: rec.listing == null ? undefined : isSkillListing(rec.listing) ? rec.listing
        : fail(`"skills[${i}].listing" must be one of ${SKILL_LISTINGS.join(", ")} (got ${JSON.stringify(rec.listing)})`),
    };
  });

  const seenViewIds = new Set<string>();
  const views = obj.views == null ? undefined : requireArray(obj.views, "views").map((entry, i) => {
    const rec = asRecord(entry, `views[${i}]`);
    const viewId = requireString(rec.id, `views[${i}].id`);
    if (seenViewIds.has(viewId)) fail(`duplicate view id "${viewId}"`);
    seenViewIds.add(viewId);
    if (rec.kind !== "iframe") fail(`views[${i}].kind must be "iframe" (got ${JSON.stringify(rec.kind)})`);
    const serve = asRecord(rec.serve, `views[${i}].serve`);
    return {
      id: viewId,
      label: requireString(rec.label, `views[${i}].label`),
      kind: "iframe" as const,
      description: optionalString(rec.description, `views[${i}].description`),
      audience: optionalAudience(rec.audience, `views[${i}].audience`),
      serve: {
        command: requireString(serve.command, `views[${i}].serve.command`),
        cwd: optionalCwd(serve.cwd, `views[${i}].serve.cwd`),
        portEnv: optionalString(serve.portEnv, `views[${i}].serve.portEnv`),
        healthPath: optionalString(serve.healthPath, `views[${i}].serve.healthPath`),
        env: optionalEnv(serve.env, `views[${i}].serve.env`),
      },
    };
  });

  const seenScriptNames = new Set<string>();
  const scripts = obj.scripts == null ? undefined : requireArray(obj.scripts, "scripts").map((entry, i) => {
    const rec = asRecord(entry, `scripts[${i}]`);
    const scriptName = requireString(rec.name, `scripts[${i}].name`);
    if (seenScriptNames.has(scriptName)) fail(`duplicate script name "${scriptName}"`);
    seenScriptNames.add(scriptName);
    return {
      name: scriptName,
      command: requireString(rec.command, `scripts[${i}].command`),
      label: optionalString(rec.label, `scripts[${i}].label`),
      description: optionalString(rec.description, `scripts[${i}].description`),
      cwd: optionalCwd(rec.cwd, `scripts[${i}].cwd`),
      audience: optionalAudience(rec.audience, `scripts[${i}].audience`),
      env: optionalEnv(rec.env, `scripts[${i}].env`),
    };
  });

  const skillNames = new Set((skills ?? []).map((s) => pluginSkillName(s.dir)));
  const seenLoopNames = new Set<string>();
  const loops = obj.loops == null ? undefined : requireArray(obj.loops, "loops").map((entry, i) => {
    const rec = asRecord(entry, `loops[${i}]`);
    const loopName = requireString(rec.name, `loops[${i}].name`);
    if (!PLUGIN_LOOP_NAME_PATTERN.test(loopName)) {
      fail(`"loops[${i}].name" must match ${PLUGIN_LOOP_NAME_PATTERN} (got "${loopName}") — the name is a segment of the ticket dedupe key, so a ":" in it would collide with a unit id`);
    }
    if (seenLoopNames.has(loopName)) fail(`duplicate loop name "${loopName}"`);
    seenLoopNames.add(loopName);
    const skill = requireString(rec.skill, `loops[${i}].skill`);
    // A loop that names a skill the manifest doesn't declare would create tickets
    // whose skill never materializes into the worktree — fail at parse time.
    if (!skillNames.has(skill)) {
      fail(`loops[${i}].skill "${skill}" is not one of the manifest's skills`);
    }
    const plan = asRecord(rec.plan, `loops[${i}].plan`);
    let maxUnits: number | undefined;
    if (rec.maxUnitsPerAdvance != null) {
      if (typeof rec.maxUnitsPerAdvance !== "number" || !Number.isInteger(rec.maxUnitsPerAdvance) || rec.maxUnitsPerAdvance < 1) {
        fail(`"loops[${i}].maxUnitsPerAdvance" must be a positive integer`);
      }
      maxUnits = rec.maxUnitsPerAdvance;
    }
    let autoLand: boolean | undefined;
    if (rec.autoLand != null) {
      if (typeof rec.autoLand !== "boolean") fail(`"loops[${i}].autoLand" must be a boolean`);
      autoLand = rec.autoLand;
    }
    let reconcileUnits: boolean | undefined;
    if (rec.reconcileUnits != null) {
      if (typeof rec.reconcileUnits !== "boolean") fail(`"loops[${i}].reconcileUnits" must be a boolean`);
      reconcileUnits = rec.reconcileUnits;
    }
    return {
      name: loopName,
      label: optionalString(rec.label, `loops[${i}].label`),
      description: optionalString(rec.description, `loops[${i}].description`),
      skill,
      workflow: optionalString(rec.workflow, `loops[${i}].workflow`),
      maxUnitsPerAdvance: maxUnits,
      autoLand,
      reconcileUnits,
      plan: {
        command: requireString(plan.command, `loops[${i}].plan.command`),
        cwd: optionalCwd(plan.cwd, `loops[${i}].plan.cwd`),
        env: optionalEnv(plan.env, `loops[${i}].plan.env`),
      },
    };
  });

  const seenDocFiles = new Set<string>();
  const docs = obj.docs == null ? undefined : requireArray(obj.docs, "docs").map((entry, i) => {
    const rec = asRecord(entry, `docs[${i}]`);
    const file = requireRelativePath(rec.file, `docs[${i}].file`);
    if (!/\.(html?|md)$/i.test(file)) fail(`"docs[${i}].file" must be an .html or .md file (got "${file}")`);
    if (seenDocFiles.has(file)) fail(`duplicate doc file "${file}"`);
    seenDocFiles.add(file);
    return {
      file,
      title: requireString(rec.title, `docs[${i}].title`),
      description: optionalString(rec.description, `docs[${i}].description`),
      audience: optionalAudience(rec.audience, `docs[${i}].audience`),
    };
  });

  const sync = obj.sync == null ? undefined : (() => {
    const rec = asRecord(obj.sync, "sync");
    const provider = requireString(rec.provider, "sync.provider");
    if (!PLUGIN_SYNC_PROVIDER_PATTERN.test(provider)) {
      fail(`"sync.provider" must match ${PLUGIN_SYNC_PROVIDER_PATTERN} (got "${provider}")`);
    }
    const pull = rec.pull == null ? undefined : parseSyncCommand(rec.pull, "sync.pull");
    const push = rec.push == null ? undefined : parseSyncCommand(rec.push, "sync.push");
    const resolve = rec.resolve == null ? undefined : parseSyncCommand(rec.resolve, "sync.resolve");
    // A sync that can do neither direction is not a sync — declaring it would render a capability
    // with nothing behind it, and the board would have no command to offer.
    if (!pull && !push) fail(`"sync" must declare at least one of "pull"/"push"`);

    const seenConfigKeys = new Set<string>();
    const config = rec.config == null ? undefined : requireArray(rec.config, "sync.config").map((entry, i) => {
      const c = asRecord(entry, `sync.config[${i}]`);
      const key = requireString(c.key, `sync.config[${i}].key`);
      if (seenConfigKeys.has(key)) fail(`duplicate sync.config key "${key}"`);
      seenConfigKeys.add(key);
      return {
        key,
        label: optionalString(c.label, `sync.config[${i}].label`),
        description: optionalString(c.description, `sync.config[${i}].description`),
        required: optionalBoolean(c.required, `sync.config[${i}].required`),
        type: (() => {
          if (c.type == null) return undefined;
          if (typeof c.type !== "string" || !(PLUGIN_SYNC_CONFIG_FIELD_TYPES as readonly string[]).includes(c.type)) {
            fail(`"sync.config[${i}].type" must be one of ${PLUGIN_SYNC_CONFIG_FIELD_TYPES.join(", ")}`);
          }
          return c.type as PluginSyncConfigFieldType;
        })(),
        options: (() => {
          if (c.options == null) return undefined;
          const list = requireArray(c.options, `sync.config[${i}].options`).map((o, j) => requireString(o, `sync.config[${i}].options[${j}]`));
          if (c.type !== "select") fail(`"sync.config[${i}].options" needs "type": "select"`);
          return list;
        })(),
      };
    });
    for (const [i, c] of (config ?? []).entries()) {
      if (c.type === "select" && !(c.options?.length)) fail(`"sync.config[${i}]" is a select and needs a non-empty "options" list`);
    }

    const seenSecrets = new Set<string>();
    const secrets = rec.secrets == null ? undefined : requireArray(rec.secrets, "sync.secrets").map((entry, i) => {
      if (typeof entry !== "string") fail(`"sync.secrets[${i}]" must be a string`);
      const name = entry.trim();
      if (!name) fail(`"sync.secrets[${i}]" must be a non-empty string`);
      if (!SYNC_SECRET_NAME_PATTERN.test(name)) {
        fail(`"sync.secrets[${i}]" must be a reference NAME matching ${SYNC_SECRET_NAME_PATTERN} (got "${name}") — the manifest declares which secret it needs, never the secret's value`);
      }
      if (looksLikeInlineSecretValue(name)) {
        fail(`"sync.secrets[${i}]" looks like an inline secret VALUE, not a reference name (got "${name}") — the manifest must name the secret, e.g. "JIRA_API_TOKEN", and let the board resolve it`);
      }
      if (seenSecrets.has(name)) fail(`duplicate sync secret name "${name}"`);
      seenSecrets.add(name);
      return name;
    });

    return { provider, pull, push, resolve, config, secrets };
  })();

  const butler = obj.butler == null ? undefined : (() => {
    const rec = asRecord(obj.butler, "butler");
    return { promptFragment: requireRelativePath(rec.promptFragment, "butler.promptFragment") };
  })();

  const scaffold = obj.scaffold == null ? undefined : (() => {
    const rec = asRecord(obj.scaffold, "scaffold");
    const targetPath = requireRelativePath(rec.targetPath, "scaffold.targetPath");
    // The scaffold is plugin-authored content written into the project on ENABLE, before any
    // script consent. Plugins are trusted-by-install, so this crosses no new boundary — but
    // `.git/hooks/pre-commit` would be executed by every later git operation in that repo, which
    // is a category of effect nobody enabling a plugin expects. Cheap to exclude.
    if (/^\.git(\/|$)/i.test(targetPath)) {
      fail(`"scaffold.targetPath" must not write inside ".git" (got "${targetPath}")`);
    }
    return {
      profileTemplate: requireRelativePath(rec.profileTemplate, "scaffold.profileTemplate"),
      targetPath,
    };
  })();

  return { id, name, version, description, skills, views, scripts, loops, docs, sync, butler, scaffold };
}

/** A sync command's field name (`sync.pull`/`sync.push`) — reused so both share one error prefix. */
function parseSyncCommand(value: unknown, field: string): PluginSyncCommandDef {
  const rec = asRecord(value, field);
  return {
    command: requireString(rec.command, `${field}.command`),
    cwd: optionalCwd(rec.cwd, `${field}.cwd`),
    env: optionalEnv(rec.env, `${field}.env`),
  };
}

/**
 * A secret REFERENCE name — the shape a credential-store key actually takes (env-var-like,
 * optionally dotted/namespaced). Deliberately narrower than a bare identifier so a pasted value
 * that happens to avoid whitespace (a UUID, a slug-shaped id) still has to clear this too.
 */
const SYNC_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * Heuristic guard against a manifest author inlining an actual secret where a reference NAME
 * belongs (#1076's "never inline secrets" requirement). Not a proof — a short opaque token could
 * still slip through — but it catches the shapes real tokens take: JWTs, common provider prefixes
 * (GitHub, Slack, OpenAI/Anthropic-style), and anything implausibly long for a name someone would
 * type by hand. An auth-header-shaped value ("Bearer xyz") is already rejected earlier by
 * `SYNC_SECRET_NAME_PATTERN`, which excludes whitespace.
 */
function looksLikeInlineSecretValue(name: string): boolean {
  if (name.length > 64) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(name)) return true; // JWT
  if (/^(ghp|gho|ghu|ghs|ghr|github_pat)_/i.test(name)) return true; // GitHub token
  if (/^xox[baprs]-/i.test(name)) return true; // Slack token
  if (/^sk-[A-Za-z0-9]/i.test(name)) return true; // OpenAI/Anthropic-style key
  return false;
}

/**
 * Parse a loop `plan` command's stdout.
 *
 * Tolerant on purpose: a planner is a third-party script, and the shell it runs
 * under happily prepends banners (npm notices, tsx warnings), so the LAST JSON
 * value in the output wins rather than requiring the whole stream to be JSON. A
 * bare array is accepted as `{ units: [...] }`. Anything else throws
 * `PluginManifestError` so the route answers 400 with the offending output.
 */
/**
 * Count unfilled `TODO:` markers left in a scaffold file's content.
 *
 * A plugin's `scaffold.profileTemplate` ships with `TODO:` markers for a human
 * to fill in; a script or loop `plan` command that reads the scaffold before
 * that happens fails with a confusing stack (or its own domain-specific "no
 * source files under TODO: e.g. src" error) instead of saying why. This is the
 * one shared signal both the enable report and the pre-run gate key off.
 */
export function countScaffoldPlaceholders(content: string): number {
  // Ignore `TODO:` inside inline-code spans. A scaffold template explains itself
  // ("Fill in every `TODO:` marker before running the pipeline"), and counting
  // that sentence made a FULLY filled-in profile report a leftover placeholder
  // forever — the loop gate then refused to run against a correct scaffold, which
  // is worse than the confusing failure the gate exists to prevent. A marker shown
  // as code is documentation ABOUT the marker; a real placeholder is a value
  // (`"language": "TODO: ts|js|..."`), which is never wrapped in backticks.
  return (content.replace(/`[^`\n]*`/g, "").match(/TODO:/g) ?? []).length;
}
