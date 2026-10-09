import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { BuilderContext, BuilderEffort, BuilderLeanProfile } from "./types.js";
import { builderProfilePref, describeBuilderLeanProfile, parseBuilderLeanProfile } from "./builder-lean-profile.js";

/**
 * Builder context policy (#1302): what a Claude Code builder inherits from the operator's
 * personal profile.
 *
 * - `isolated` (default): `--setting-sources project,local`. Measured on the board's Claude
 *   Code: user skills drop out of the init message (122 -> 90 here), the user `CLAUDE.md` is
 *   not loaded, and user hooks are not registered. The project's `.claude/settings.json`
 *   (safety hooks, permissions), its skills and `CLAUDE.md` stay. Credentials are not a
 *   settings source, so OAuth profiles (`CLAUDE_CONFIG_DIR`) keep authenticating, and
 *   `--settings settings_<profile>.json` is a separate flag source that still applies.
 * - `inherit`: the previous launch args, unchanged.
 *
 * Provider scope: Claude CLI builders (`--setting-sources`) and Codex builders (`-c` overrides,
 * see `codexIsolationConfigArgs`, #1310). Copilot and Pi have no such lever (declared
 * unsupported, see `BUILDER_CONTEXT_SUPPORT`); the Butler and other
 * in-process Agent SDK sessions are out of scope (they are not builders and own their
 * `settingSources`).
 */
export const BUILDER_CONTEXT_POLICIES = ["isolated", "inherit"] as const;
export type BuilderContextPolicy = (typeof BUILDER_CONTEXT_POLICIES)[number];
export const DEFAULT_BUILDER_CONTEXT_POLICY: BuilderContextPolicy = "isolated";

export const BUILDER_CONTEXT_SETTING_SOURCES = "project,local";

export const builderContextPref = projectPref("builder_context");

/**
 * Session tuning the board pins on a Claude builder's command line, so it is a board decision
 * and not whatever `effortLevel` / `autoCompactWindow` the operator's user settings carry.
 * Isolation drops the user settings, so without these an isolated builder silently ran on the
 * CLI defaults instead of the values the user scope used to supply. Under `isolated` the
 * defaults below apply; under `inherit` only a pref the operator set is passed, so the default
 * inherit launch stays byte-identical to the pre-#1302 one.
 */
export const builderEffortPref = projectPref("builder_effort");
export const builderAutocompactPref = projectPref("builder_autocompact");
export const BUILDER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly BuilderEffort[];
export const DEFAULT_BUILDER_EFFORT: BuilderEffort = "medium";
export const DEFAULT_BUILDER_AUTOCOMPACT = "500000";
// The types live in `types.ts`, which the worker binary imports: declaring them here would pull
// this module (and its shared import) into the worker's graph (worker-cli-isolation.test.ts).
export type { BuilderContext, BuilderEffort };

export const BUILDER_CONTEXT_SUPPORT: Record<string, "supported" | string> = {
  claude: "supported",
  codex: "supported",
  copilot: "unsupported: no settings-source switch",
  pi: "unsupported: skills and extensions are already passed explicitly by the board",
  herdr: "unsupported: Herdr hosts a pane, it is not a builder provider",
};

/**
 * Codex isolated builder (#1310): `-c` overrides, verified against codex 0.154.0 by their effect
 * (`codex mcp list`, `codex debug prompt-input`, a real `codex exec --json`), not by exit code.
 * Auth, `--profile`/`--model`/`model_provider`, the project's `.codex/hooks.json` and its skills
 * are untouched, and `CODEX_HOME` stays whatever the license ring chose, so no auth is copied.
 *
 * - `notify=[]`: no external notifier exe per turn.
 * - `features.plugins=false`: no installed plugins, which also removes their MCP servers
 *   (`codex_app`, `cua_repl`) and plugin skills.
 * - `skills.bundled.enabled=false`: no bundled `.system` skills.
 * - per user MCP server `mcp_servers.<name>.enabled=false`, per user skill `skills.config`.
 *   Codex cannot be told "none of the user scope", so `discoverCodexUserScope` names them.
 *
 * Values avoid double quotes and whitespace: Windows spawns codex through a shell when the
 * direct entry point cannot be resolved, and node does not escape arguments there.
 */
export const CODEX_ISOLATION_BASE_OVERRIDES = ["notify=[]", "features.plugins=false", "skills.bundled.enabled=false"] as const;
const SHELL_SAFE_VALUE = /^[\w.:\\/-]+$/;
// The board's own MCP server must survive isolation.
const KEPT_CODEX_MCP_SERVERS = new Set(["agentic-kanban"]);

export function codexIsolationConfigArgs(scope?: BuilderContext["codexUserScope"]): string[] {
  const overrides: string[] = [...CODEX_ISOLATION_BASE_OVERRIDES];
  for (const name of scope?.mcpServers ?? []) overrides.push(`mcp_servers.${name}.enabled=false`);
  // One array: repeated `-c skills.config=` overrides replace each other (last wins), measured.
  if (scope?.skillPaths.length) overrides.push(`skills.config=[${scope.skillPaths.map((p) => `{path='${p}',enabled=false}`).join(",")}]`);
  return overrides.flatMap((value) => ["-c", value]);
}

/**
 * User-scope MCP servers (bare-key `[mcp_servers.<name>]` headers of `<codexHome>/config.toml`) and
 * skills (`<codexHome>/skills/<dir>/SKILL.md`, excluding the bundled `.system`). Names and paths
 * only: no value from the config is read or logged. Best effort: anything unreadable yields none.
 */
export function discoverCodexUserScope(codexHome: string): NonNullable<BuilderContext["codexUserScope"]> {
  const mcpServers = new Set<string>();
  try {
    for (const m of readFileSync(join(codexHome, "config.toml"), "utf8").matchAll(/^\s*\[mcp_servers\.([\w-]+)[\].]/gm)) {
      if (!KEPT_CODEX_MCP_SERVERS.has(m[1])) mcpServers.add(m[1]);
    }
  } catch { /* no config.toml: nothing to switch off */ }
  const skillPaths: string[] = [];
  try {
    // Not `withFileTypes`: a linked skill dir is a symlink/junction, which is not `isDirectory()`.
    for (const name of readdirSync(join(codexHome, "skills"))) {
      if (name.startsWith(".")) continue;
      const path = join(codexHome, "skills", name, "SKILL.md");
      if (SHELL_SAFE_VALUE.test(path) && existsSync(path)) skillPaths.push(path);
    }
  } catch { /* no user skills dir */ }
  return { mcpServers: [...mcpServers].sort(), skillPaths };
}

/** The CODEX_HOME a launch runs under: the rotation's choice, else the inherited one, else `~/.codex`. */
export function effectiveCodexHome(extraEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return extraEnv?.CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Whether the builder context policy covers this executor (`BUILDER_CONTEXT_SUPPORT`). */
export function builderContextApplies(executor: string, builderSession: boolean): boolean {
  return builderSession && (executor === "claude-code" || executor === "codex");
}

/** Codex has no "drop the user scope" key: name what to drop for the CODEX_HOME this launch runs under. Returns extraEnv untouched. */
export function applyCodexUserScope(executor: string, builderContext: BuilderContext | undefined, extraEnv: Record<string, string> | undefined): Record<string, string> | undefined {
  if (executor === "codex" && builderContext?.policy === "isolated") {
    builderContext.codexUserScope = discoverCodexUserScope(effectiveCodexHome(extraEnv));
  }
  return extraEnv;
}

/**
 * The effective policy for one launch, logged so the operator can see it. Undefined when the
 * launch is not a builder of a supported provider (the policy does not apply to it).
 */
export async function resolveBuilderContext(
  applies: boolean,
  projectId: string,
  workspaceId: string,
  readPref: (key: string) => Promise<string | null | undefined>,
  claudeLean = false,
  onLean?: (lean: BuilderLeanProfile) => Promise<void>,
): Promise<BuilderContext | undefined> {
  if (!applies) return undefined;
  const read = async (key: string) => (projectId ? await readPref(key) : undefined);
  const policy = parseBuilderContextPolicy(await read(builderContextPref.key(projectId)));
  const isolated = policy === "isolated";
  const effort = parseBuilderEffort(await read(builderEffortPref.key(projectId))) ?? (isolated ? DEFAULT_BUILDER_EFFORT : undefined);
  const autocompact = parseBuilderAutocompact(await read(builderAutocompactPref.key(projectId))) ?? (isolated ? DEFAULT_BUILDER_AUTOCOMPACT : undefined);
  const lean = isolated && claudeLean ? parseBuilderLeanProfile(await read(builderProfilePref.key(projectId))) : undefined;
  if (lean) await onLean?.(lean);
  console.log(`[session] builder context: ${policy} effort=${effort ?? "-"} autocompact=${autocompact ?? "-"}${lean ? ` lean: ${describeBuilderLeanProfile(lean)}` : ""} workspaceId=${workspaceId}`);
  return { policy, ...(effort ? { effort } : {}), ...(autocompact ? { autocompact } : {}), ...(lean ? { lean } : {}) };
}

/** A recognised effort level, or undefined (unset or unknown: the default decides). */
export function parseBuilderEffort(value: string | null | undefined): BuilderEffort | undefined {
  const v = (value ?? "").trim().toLowerCase();
  return (BUILDER_EFFORT_LEVELS as readonly string[]).includes(v) ? (v as BuilderEffort) : undefined;
}

/** `auto` or an integer token count in the CLI's 100k–1M range, or undefined. */
export function parseBuilderAutocompact(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "auto") return v;
  const n = Number(v);
  return v !== "" && Number.isInteger(n) && n >= 100_000 && n <= 1_000_000 ? String(n) : undefined;
}

/** Unset or unrecognised values fall back to the default, never to a surprise. */
export function parseBuilderContextPolicy(value: string | null | undefined): BuilderContextPolicy {
  const v = (value ?? "").trim().toLowerCase();
  return (BUILDER_CONTEXT_POLICIES as readonly string[]).includes(v)
    ? (v as BuilderContextPolicy)
    : DEFAULT_BUILDER_CONTEXT_POLICY;
}
