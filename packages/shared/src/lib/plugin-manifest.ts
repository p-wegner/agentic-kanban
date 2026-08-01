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

export interface PluginSkillDef {
  /** Directory inside the plugin repo containing a SKILL.md (e.g. ".claude/skills/x"). */
  dir: string;
}

export interface PluginViewServeDef {
  /** Shell command that starts the view's HTTP server, run with cwd = plugin dir. */
  command: string;
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
  serve: PluginViewServeDef;
}

export interface PluginScriptDef {
  name: string;
  /** Shell command. */
  command: string;
  /** Where the command runs: the plugin's own checkout or the project repo. Default "repo". */
  cwd?: "plugin" | "repo";
  /** Extra env vars; values support the same placeholders as view env. */
  env?: Record<string, string>;
}

export interface PluginManifest {
  /** Unique slug ([a-z0-9-]+); doubles as the install directory name and pref-key segment. */
  id: string;
  name: string;
  version?: string;
  skills?: PluginSkillDef[];
  views?: PluginViewDef[];
  scripts?: PluginScriptDef[];
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

  const skills = obj.skills == null ? undefined : requireArray(obj.skills, "skills").map((entry, i) => {
    const rec = asRecord(entry, `skills[${i}]`);
    return { dir: requireRelativePath(rec.dir, `skills[${i}].dir`) };
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
      serve: {
        command: requireString(serve.command, `views[${i}].serve.command`),
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
    const cwd = rec.cwd == null ? undefined : rec.cwd;
    if (cwd !== undefined && cwd !== "plugin" && cwd !== "repo") {
      fail(`scripts[${i}].cwd must be "plugin" or "repo" (got ${JSON.stringify(cwd)})`);
    }
    return {
      name: scriptName,
      command: requireString(rec.command, `scripts[${i}].command`),
      cwd: cwd as "plugin" | "repo" | undefined,
      env: optionalEnv(rec.env, `scripts[${i}].env`),
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

  return { id, name, version, skills, views, scripts, butler, scaffold };
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
