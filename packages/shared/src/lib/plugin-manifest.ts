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
 *   "skills": [{ "dir": ".claude/skills/requirement-extraction" }],
 *   "views": [{ "id": "coverage", "label": "Coverage", "kind": "iframe",
 *               "serve": { "command": "node tools/coverage/serve.mjs", "portEnv": "PORT",
 *                          "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "scripts": [{ "name": "coverage", "command": "npm run coverage", "cwd": "plugin",
 *                 "env": { "COVERAGE_ROOT": "{{repoPath}}" } }],
 *   "loops": [{ "name": "requirement-extraction", "skill": "requirement-extraction",
 *               "plan": { "command": "node tools/loop-plan.mjs --json", "cwd": "plugin",
 *                         "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "butler": { "promptFragment": "butler-fragment.md" },
 *   "scaffold": { "profileTemplate": "profile-template.md",
 *                 "targetPath": "docs/analysis/_project-profile.md" }
 * }
 * ```
 */

/** The manifest file name, at the plugin repo root. */
export const PLUGIN_MANIFEST_FILENAME = "kanban-plugin.json";

/** Valid plugin slug: lowercase alphanumerics and dashes. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/;

/** Where a manifest command runs: the plugin's own checkout or the project repo. */
export type PluginCwd = "plugin" | "repo";

export interface PluginSkillDef {
  /** Directory inside the plugin repo containing a SKILL.md (e.g. ".claude/skills/x"). */
  dir: string;
  /** One-line "what this skill does", surfaced next to its Run button. */
  description?: string;
}

export interface PluginViewServeDef {
  /** Shell command that starts the view's HTTP server. */
  command: string;
  /** Where the command runs. Default "plugin" — a view server ships with the plugin. */
  cwd?: PluginCwd;
  /** Env var name the server reads its port from (e.g. "PORT"). */
  portEnv?: string;
  /** Extra env vars; values support {{repoPath}}/{{projectName}}/{{pluginPath}}/{{port}}. */
  env?: Record<string, string>;
}

export interface PluginViewDef {
  id: string;
  label: string;
  /** Only "iframe" is supported in this slice. */
  kind: "iframe";
  description?: string;
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
 * gates. An empty `plan` output means converged and the loop stops.
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
   * Safety stop: refuse to create more than this many tickets for one advance.
   * Defaults to `DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE`.
   */
  maxUnitsPerAdvance?: number;
}

export interface PluginLoopPlanDef {
  /** Shell command whose stdout is the plan JSON (see `parsePluginLoopPlan`). */
  command: string;
  /** Where the command runs. Default "plugin" — a planner ships with the plugin. */
  cwd?: PluginCwd;
  /** Extra env vars; values support the same placeholders as script env. */
  env?: Record<string, string>;
}

/** One outstanding piece of loop work, as printed by a loop's `plan` command. */
export interface PluginLoopUnit {
  /**
   * Stable identity of the unit WITHIN the loop (e.g. "billing:round-3"). The
   * board derives the ticket's dedupe key from it, so a re-plan that still names
   * the same unit must reuse the same id or the loop will duplicate tickets.
   */
  id: string;
  title: string;
  /** The ticket body — the brief the skill runs against. */
  description?: string;
}

export interface PluginLoopPlan {
  units: PluginLoopUnit[];
  /**
   * The planner's own convergence verdict. Optional: an empty `units` list
   * already means converged, but a planner may report it explicitly (and may
   * report `converged: false` with no units to mean "blocked, not done").
   */
  converged?: boolean;
  /** Free-text note surfaced in the UI (e.g. "3/19 modules converged"). */
  note?: string;
}

/** Cap on tickets one loop advance may create when the loop declares none. */
export const DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE = 10;

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

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(`Invalid ${PLUGIN_MANIFEST_FILENAME}: ${message}`);
    this.name = "PluginManifestError";
  }
}

function fail(message: string): never {
  throw new PluginManifestError(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`"${field}" must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") fail(`"${field}" must be a string`);
  return value.trim() || undefined;
}

function optionalEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object of string values`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") fail(`"${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function optionalCwd(value: unknown, field: string): PluginCwd | undefined {
  if (value == null) return undefined;
  if (value !== "plugin" && value !== "repo") {
    fail(`"${field}" must be "plugin" or "repo" (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object`);
  return value as Record<string, unknown>;
}

/**
 * A manifest-relative path must stay relative and inside the tree it is resolved
 * against (plugin root or project root) — reject absolute paths and `..` escapes
 * at parse time so no consumer has to re-check.
 */
function requireRelativePath(value: unknown, field: string): string {
  const text = requireString(value, field).replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(text)) fail(`"${field}" must be a relative path (got "${text}")`);
  const segments = text.split("/");
  if (segments.includes("..")) fail(`"${field}" must not contain ".." (got "${text}")`);
  return text;
}

/**
 * Parse + validate a `kanban-plugin.json` blob. Accepts the raw JSON text or an
 * already-parsed object; throws `PluginManifestError` with a field-precise
 * message on any violation. Unknown top-level fields are ignored (forward compat).
 */
export function parsePluginManifest(input: string | unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      fail(`not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
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
      serve: {
        command: requireString(serve.command, `views[${i}].serve.command`),
        cwd: optionalCwd(serve.cwd, `views[${i}].serve.cwd`),
        portEnv: optionalString(serve.portEnv, `views[${i}].serve.portEnv`),
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
      env: optionalEnv(rec.env, `scripts[${i}].env`),
    };
  });

  const skillNames = new Set((skills ?? []).map((s) => s.dir.split("/").pop()!));
  const seenLoopNames = new Set<string>();
  const loops = obj.loops == null ? undefined : requireArray(obj.loops, "loops").map((entry, i) => {
    const rec = asRecord(entry, `loops[${i}]`);
    const loopName = requireString(rec.name, `loops[${i}].name`);
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
    return {
      name: loopName,
      label: optionalString(rec.label, `loops[${i}].label`),
      description: optionalString(rec.description, `loops[${i}].description`),
      skill,
      maxUnitsPerAdvance: maxUnits,
      plan: {
        command: requireString(plan.command, `loops[${i}].plan.command`),
        cwd: optionalCwd(plan.cwd, `loops[${i}].plan.cwd`),
        env: optionalEnv(plan.env, `loops[${i}].plan.env`),
      },
    };
  });

  const butler = obj.butler == null ? undefined : (() => {
    const rec = asRecord(obj.butler, "butler");
    return { promptFragment: requireRelativePath(rec.promptFragment, "butler.promptFragment") };
  })();

  const scaffold = obj.scaffold == null ? undefined : (() => {
    const rec = asRecord(obj.scaffold, "scaffold");
    return {
      profileTemplate: requireRelativePath(rec.profileTemplate, "scaffold.profileTemplate"),
      targetPath: requireRelativePath(rec.targetPath, "scaffold.targetPath"),
    };
  })();

  return { id, name, version, description, skills, views, scripts, loops, butler, scaffold };
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
export function parsePluginLoopPlan(stdout: string): PluginLoopPlan {
  const text = stdout.trim();
  if (!text) fail("loop plan command printed no output");

  // Scan back from the end for the last balanced JSON object/array.
  let raw: unknown;
  let parsed = false;
  for (let start = text.length - 1; start >= 0 && !parsed; start--) {
    const ch = text[start];
    if (ch !== "{" && ch !== "[") continue;
    try {
      raw = JSON.parse(text.slice(start));
      parsed = true;
    } catch {
      /* not a complete value at this offset — keep scanning left */
    }
  }
  if (!parsed) fail(`loop plan output is not JSON: ${text.slice(-400)}`);

  const obj = Array.isArray(raw) ? { units: raw } : asRecord(raw, "loop plan");
  const seen = new Set<string>();
  const units = requireArray(obj.units ?? [], "loop plan units").map((entry, i) => {
    const rec = asRecord(entry, `units[${i}]`);
    const unitId = requireString(rec.id, `units[${i}].id`);
    if (seen.has(unitId)) fail(`loop plan repeats unit id "${unitId}"`);
    seen.add(unitId);
    return {
      id: unitId,
      title: requireString(rec.title, `units[${i}].title`),
      description: optionalString(rec.description, `units[${i}].description`),
    };
  });

  if (obj.converged != null && typeof obj.converged !== "boolean") fail(`"converged" must be a boolean`);
  return {
    units,
    converged: (obj.converged as boolean | undefined) ?? units.length === 0,
    note: optionalString(obj.note, "note"),
  };
}

/**
 * Dedupe key stamped onto every ticket a loop advance creates, and matched
 * against on the next advance so a still-outstanding unit is never re-ticketed.
 * Kept in the shared lib so the server (which writes it) and any consumer that
 * needs to recognise loop tickets derive it identically.
 */
export function pluginLoopUnitKey(pluginSlug: string, loopName: string, unitId: string): string {
  return `plugin-loop:${pluginSlug}:${loopName}:${unitId}`;
}

export interface PluginPlaceholderVars {
  repoPath?: string;
  projectName?: string;
  pluginPath?: string;
  port?: number | string;
}

/**
 * Substitute the supported `{{placeholder}}`s in a manifest env value or template
 * text. Unknown placeholders are left as-is; a placeholder whose var is not
 * provided is also left as-is (so a later pass — e.g. `{{port}}` at serve time —
 * can fill it).
 */
export function substitutePluginPlaceholders(text: string, vars: PluginPlaceholderVars): string {
  let out = text;
  if (vars.repoPath !== undefined) out = out.replace(/\{\{repoPath}}/g, vars.repoPath);
  if (vars.projectName !== undefined) out = out.replace(/\{\{projectName}}/g, vars.projectName);
  if (vars.pluginPath !== undefined) out = out.replace(/\{\{pluginPath}}/g, vars.pluginPath);
  if (vars.port !== undefined) out = out.replace(/\{\{port}}/g, String(vars.port));
  return out;
}

/** Apply placeholder substitution to every value of a manifest env map. */
export function substitutePluginEnv(
  env: Record<string, string> | undefined,
  vars: PluginPlaceholderVars,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = substitutePluginPlaceholders(v, vars);
  return out;
}

/** The per-project enable pref key for a plugin: `plugin_enabled_<pluginSlug>_<projectId>`. */
export function pluginEnabledPreferenceKey(pluginSlug: string, projectId: string): string {
  return `plugin_enabled_${pluginSlug}_${projectId}`;
}

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
  return (content.match(/TODO:/g) ?? []).length;
}
