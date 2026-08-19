/**
 * The `{{placeholder}}` vocabulary a plugin manifest may use, and the substitution
 * that fills it in. Split out of `plugin-manifest.ts` (#554) — it is a cohesive
 * concern of its own, and that file sits on the god-module ceiling. The manifest
 * module re-exports the whole surface, so every existing importer is unchanged.
 */

export interface PluginPlaceholderVars {
  /** Where this plugin's output goes — the project's leading repo, or a sidecar repo. */
  repoPath?: string;
  /** The project's leading (product) repo, regardless of output location. Lets a manifest
   *  read the source from `{{leadingRepoPath}}` while writing output to `{{repoPath}}`. */
  leadingRepoPath?: string;
  projectName?: string;
  pluginPath?: string;
  port?: number | string;
  /** Externally REACHABLE base URL of the board's REST API — scheme+host+port, no trailing
   *  slash (e.g. `http://localhost:3001`). This is what a plugin view server, script, or loop
   *  planner calls to read board data. In dev the backend binds an INTERNAL port behind the
   *  stable proxy; this is always the public (proxy) URL, never the internal one. */
  boardUrl?: string;
  /** The board project the view/script/loop was started FOR — the id to pass as `projectId`
   *  in board API calls. */
  projectId?: string;
}

/**
 * Every supported placeholder, in the order the docs table lists them
 * (docs/plugin-development.md). This tuple IS the list — the substitution below
 * iterates it, so adding a placeholder is one entry here plus one field on
 * `PluginPlaceholderVars`, not another branch in a hand-maintained if-ladder
 * that the docs table could silently drift from (#554).
 */
export const PLUGIN_PLACEHOLDER_KEYS = [
  "repoPath",
  "leadingRepoPath",
  "projectName",
  "pluginPath",
  "port",
  "boardUrl",
  "projectId",
] as const satisfies ReadonlyArray<keyof PluginPlaceholderVars>;

/**
 * The placeholder vars for one plugin run — butler fragment, script, view, loop plan,
 * loop gate. All five assembled the same six fields by hand (#554), and the one that
 * got a field wrong (`{{repoPath}}` handed the LEADING repo instead of the output repo)
 * shipped a fragment naming a directory with nothing in it.
 *
 * `repoPath` is the OUTPUT repo (leading repo, or the plugin's sidecar);
 * `leadingRepoPath` is always the product repo, so a plugin that READS the source and
 * WRITES elsewhere can say so.
 */
export function buildPluginPlaceholderVars(input: {
  outputRepoPath: string;
  leadingRepoPath: string;
  projectName: string;
  pluginPath: string;
  projectId: string;
  boardUrl?: string;
  /** Only a view has one — allocated per start, so it is filled at serve time. */
  port?: number | string;
}): PluginPlaceholderVars {
  return {
    repoPath: input.outputRepoPath,
    leadingRepoPath: input.leadingRepoPath,
    projectName: input.projectName,
    pluginPath: input.pluginPath,
    ...(input.port !== undefined ? { port: input.port } : {}),
    boardUrl: input.boardUrl,
    projectId: input.projectId,
  };
}

/**
 * Substitute the supported `{{placeholder}}`s in a manifest env value or template
 * text. Unknown placeholders are left as-is; a placeholder whose var is not
 * provided is also left as-is (so a later pass — e.g. `{{port}}` at serve time —
 * can fill it).
 */
export function substitutePluginPlaceholders(text: string, vars: PluginPlaceholderVars): string {
  let out = text;
  for (const key of PLUGIN_PLACEHOLDER_KEYS) {
    const value = vars[key];
    if (value === undefined) continue;
    // split/join, not a RegExp: the token is a literal and braces are regex syntax.
    out = out.split("{{" + key + "}}").join(String(value));
  }
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
