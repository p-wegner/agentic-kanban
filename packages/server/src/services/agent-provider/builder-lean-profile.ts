import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { BuilderLeanProfile } from "./types.js";

/**
 * Lean Claude builder profile (#1312): under `isolated`, what a Claude builder drops from its first
 * request, and what a project can add back. Measured on this repo (Claude Code 2.1.291, sonnet):
 * 40.0k -> 23.1k tokens (-42%), each lever alone against the base:
 *
 * - auto-memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`): -7.8k. Also a correctness fix: the
 *   builder otherwise loads the OPERATOR's private `~/.claude/projects/<repo>/memory/MEMORY.md`.
 * - built-in tool trim (`--disallowedTools`): -5.0k.
 * - non-core skills listed `name-only` (`skillOverrides`): -2.4k. Never `off` and never
 *   `--disable-slash-commands`: with skills unavailable the `Workflow` tool inlines its whole
 *   authoring guide and the context GROWS (+3.7k / +2.3k).
 * - claude.ai connectors off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`): -1.7k.
 *
 * Per-project pref `builder_profile_<id>` is a JSON object, every key optional:
 * `{ "autoMemory": true, "tools": {"add": ["Workflow"]}, "skills": {"full": ["x"]},
 *    "mcp": {"claudeAi": true, "configs": ["<mcp json>"]}, "plugins": ["<--plugin-dir>"] }`.
 * `inherit` ignores all of it: that launch stays byte-identical to the pre-#1312 one.
 */
export const builderProfilePref = projectPref("builder_profile");

/** Built-in tools a builder never needs: scheduling, cross-session messaging, notebooks, worktree switching. */
export const LEAN_DISALLOWED_TOOLS = [
  "Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents", "CronCreate", "CronDelete", "CronList",
  "DesignSync", "EnterWorktree", "ExitWorktree", "NotebookEdit", "PushNotification", "RemoteTrigger",
  "SendMessage", "TaskStop",
] as const;

/** Skills listed in full under the lean base, each with the reason it earns its description tokens. */
export const CORE_BUILDER_SKILLS: Record<string, string> = {
  "scope-guard": "pre-commit scope check the builder workflow prescribes",
  "flaky-test-triage": "decides whether a red test is real, on every failing run",
  "dev-server": "worktree-safe server start/stop; the wrong way flashes windows and kills other agents",
  "db-doctor": "the only sanctioned DB repair path; the alternative is a destructive guess",
  "shared-checkout-commit": "commit recipe when other agents share the checkout",
  "e2e-author": "anti-flake scaffold for new Playwright tests",
  "playwright-cli": "browser automation entry point for UI work",
  "board-navigator": "board tool/command reference",
  "kanban-workflow": "how to report progress on the board",
  "code-review": "the review prompt itself",
};

export function defaultBuilderLeanProfile(): BuilderLeanProfile {
  return { autoMemory: false, disallowedTools: [...LEAN_DISALLOWED_TOOLS], skillsFull: [], claudeAiMcp: false, mcpConfigs: [], pluginDirs: [] };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

/** The lean base with the project's add-backs applied. Unset or unparseable pref = the base. */
export function parseBuilderLeanProfile(raw: string | null | undefined): BuilderLeanProfile {
  const profile = defaultBuilderLeanProfile();
  if (raw == null || raw.trim() === "") return profile;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return profile;
    o = parsed as Record<string, unknown>;
  } catch {
    return profile;
  }
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  if (o.autoMemory === true) profile.autoMemory = true;
  const add = new Set(strings(obj(o.tools).add));
  profile.disallowedTools = profile.disallowedTools.filter((t) => !add.has(t));
  profile.skillsFull = strings(obj(o.skills).full);
  const mcp = obj(o.mcp);
  if (mcp.claudeAi === true) profile.claudeAiMcp = true;
  profile.mcpConfigs = strings(mcp.configs);
  profile.pluginDirs = strings(o.plugins);
  return profile;
}

/** One-line summary for the `[session] builder context:` log. */
export function describeBuilderLeanProfile(p: BuilderLeanProfile): string {
  const trimmed = LEAN_DISALLOWED_TOOLS.filter((t) => p.disallowedTools.includes(t)).length;
  return `memory=${p.autoMemory ? "on" : "off"} toolsTrimmed=${trimmed}/${LEAN_DISALLOWED_TOOLS.length}` +
    ` skillsFull=${p.skillsFull.length ? p.skillsFull.join("+") : "-"} claudeAi=${p.claudeAiMcp ? "on" : "off"}` +
    ` mcpConfigs=${p.mcpConfigs.length} plugins=${p.pluginDirs.length}`;
}

/** Env a lean builder's Claude process gets. */
export function leanProfileEnv(p: BuilderLeanProfile): Record<string, string> {
  return {
    ...(p.autoMemory ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
    ...(p.claudeAiMcp ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
  };
}

/** Extra Claude CLI args a lean builder gets. */
export function leanProfileArgs(p: BuilderLeanProfile): string[] {
  return [
    ...(p.disallowedTools.length ? ["--disallowedTools", p.disallowedTools.join(",")] : []),
    ...p.mcpConfigs.flatMap((c) => ["--mcp-config", c]),
    ...p.pluginDirs.flatMap((d) => ["--plugin-dir", d]),
  ];
}
