import { readBoardEnv } from "../../lib/env-registry.js";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FileSystem } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { getDbUrl } from "../../db/data-dir.js";

export const nodeFileSystem: FileSystem = {
  existsSync,
  readFileSync: (path: string, encoding: BufferEncoding) => readFileSync(path, encoding),
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => writeFileSync(path, data, encoding),
};

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_PATH = resolve(__dirname, "../../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

/**
 * How to invoke the agentic-kanban MCP server. In a bundled install (npm package,
 * Docker image) the compiled `mcp.js` sits next to `dist/server.js` or one level above
 * `dist/cli/index.js` — helpers.ts is inlined into BOTH bundles, so probe both. Only a
 * dev checkout falls back to tsx + the TypeScript source.
 */
export function resolveMcpServerInvocation(fs: FileSystem = nodeFileSystem): { command: string; args: string[] } {
  for (const candidate of [resolve(__dirname, "mcp.js"), resolve(__dirname, "../mcp.js")]) {
    if (fs.existsSync(candidate)) return { command: "node", args: [candidate] };
  }
  // Dev-checkout fallback (tsx + TypeScript source) — the pre-bundle-fix behavior.
  // Returned even when the source path is missing (matching the old unconditional
  // behavior; providers embed this config without probing), but warn loudly so a
  // broken install is diagnosable instead of agents silently lacking MCP tools.
  if (!fs.existsSync(MCP_SERVER_PATH)) {
    console.warn(
      `[agent] agentic-kanban MCP server not found — probed bundled paths ${resolve(__dirname, "mcp.js")}, ${resolve(__dirname, "../mcp.js")} and source path ${MCP_SERVER_PATH}. Agents may lack kanban MCP tools.`,
    );
  }
  return { command: "node", args: ["--import", TSX_URL, MCP_SERVER_PATH] };
}

let claudeMcpConfigPath: string | null = null;

// --- Copilot constants ---

export const COPILOT_PLAN_PROMPT_PREFIX = [
  "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files.",
  "Do NOT run commands that make changes (git, npm, pnpm, yarn, pip, etc.). Only read and explore the codebase,",
  "analyze the issue, and produce a detailed implementation plan.",
  "",
  "At the very END of your response, output the complete plan as Markdown wrapped EXACTLY between",
  "these two marker lines, each on its own line with nothing else on the line:",
  PLAN_BEGIN_MARKER,
  "<your full markdown implementation plan here>",
  PLAN_END_MARKER,
  "Then stop.",
].join("\n");

export const COPILOT_PLAN_DENIED_TOOLS = [
  "write",
  "shell(git add)",
  "shell(git commit)",
  "shell(git reset)",
  "shell(git checkout)",
  "shell(git clean)",
  "shell(git push)",
  "shell(npm install)",
  "shell(pnpm install)",
  "shell(yarn install)",
  "shell(pip install)",
  "shell(rm)",
  "shell(del)",
  "shell(Remove-Item)",
];

export const COPILOT_DEFAULT_ALLOWED_TOOLS = [
  "read",
  "write",
  "search",
  "shell",
  "agentic-kanban",
];

// NOTE (#951): the former COPILOT_SESSION_ID_TYPES set and the
// extractCopilotAssistantText fork that lived here were dead code (no
// consumers) duplicating the single sources of truth in
// @agentic-kanban/shared/lib/agent-stream/{copilot-event-types,copilot}.ts.
// Copilot event interpretation belongs there — do not re-add forks here.

// --- MCP config ---

export function getMcpConfigPath(fs: FileSystem = nodeFileSystem): string {
  if (claudeMcpConfigPath && fs.existsSync(claudeMcpConfigPath)) return claudeMcpConfigPath;
  const invocation = resolveMcpServerInvocation(fs);
  const config = {
    mcpServers: {
      "agentic-kanban": invocation,
    },
  };
  const path = resolve(tmpdir(), "agentic-kanban-mcp-config.json");
  fs.writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  claudeMcpConfigPath = path;
  console.log(`[agent] Claude MCP config written to ${path}`);
  return path;
}

/**
 * The agentic-kanban MCP server as an in-memory stdio config, for the Claude Agent
 * SDK's `options.mcpServers` (the butler). Mirrors `getMcpConfigPath` but returns the
 * object the SDK expects rather than a config-file path. `SERVER_PORT` is forwarded so
 * the MCP server's tools can call back to this server.
 */
export function getMcpServersConfig(): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const serverPort = String(resolveBoardServerPort()); // #615 — the one ladder
  // Pin the spawned MCP server to the SAME database this server uses. Without this it
  // re-runs data-dir resolution under a different cwd and can fall back to
  // ~/.agentic-kanban (a different DB), so the butler would answer about the wrong board.
  const invocation = resolveMcpServerInvocation();
  return {
    "agentic-kanban": {
      command: invocation.command,
      args: invocation.args,
      env: { SERVER_PORT: serverPort, DB_URL: getDbUrl() },
    },
  };
}

// --- Environment building ---

/** The subset of a Claude `settings_*.json` profile we read at the parse boundary. */
interface ClaudeProfileSettings {
  env?: Record<string, string>;
}

/**
 * Env-var name PREFIXES that belong to whatever Claude profile is being launched and must be
 * stripped from the inherited server env before a session is spawned — otherwise a credential
 * the server happens to hold (its own login, a previously-applied profile) BLEEDS into a
 * session launched for a different profile and silently authenticates the wrong account.
 *
 * This is a DENYLIST, not an allowlist: any new `ANTHROPIC_*` (e.g. `ANTHROPIC_SMALL_FAST_MODEL`,
 * `ANTHROPIC_DEFAULT_*`) or `CLAUDE_CODE_*` (e.g. `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_USE_VERTEX`) var is stripped without having to be enumerated, closing the gap where a
 * non-`ANTHROPIC_`-prefixed auth var (notably `CLAUDE_CODE_OAUTH_TOKEN`) slipped through the old
 * hardcoded 5-key list.
 */
const PROFILE_OWNED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];

/** Profile-owned vars whose names don't match {@link PROFILE_OWNED_ENV_PREFIXES}. */
const PROFILE_OWNED_ENV_VARS = ["API_TIMEOUT_MS"];

/** True if `key` is a Claude profile-owned auth/endpoint/model var that must not bleed across profiles. */
function isProfileOwnedEnvVar(key: string): boolean {
  return (
    PROFILE_OWNED_ENV_VARS.includes(key) ||
    PROFILE_OWNED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Vars belonging to the OPERATOR's own interactive agent session, which a board-spawned agent
 * must never inherit. Today that is the ACP agent bus (`C:\projectsndrenacp`): a session on
 * the bus exports `ACP_AUTOCONNECT=1` plus its own identity (`ACP_AGENT_NAME`/`ACP_AGENT_FILE`),
 * and `pnpm dev` started from such a session hands all three to every agent it spawns.
 *
 * Two things go wrong then. The identity vars make the child act AS the operator's agent on the
 * bus instead of itself, and `ACP_AUTOCONNECT=1` force-overrides ACP's own opt-outs — including
 * the one that keeps it out of headless sessions. That second one is fatal: verified against
 * claude 2.1.237 on Windows, a headless run (`-p` / the Agent SDK) does not return until every
 * process in its tree has exited, so ACP's detached heartbeat child wedges the launch forever —
 * zero output, past the hook's own timeout, until the 900s hang watchdog kills the session. It
 * took out every builder launch AND the butler on this machine.
 *
 * So the board strips the whole prefix: an agent's bus membership is the agent's own business,
 * never something inherited from whoever happened to run `pnpm dev`.
 */
const OPERATOR_SESSION_ENV_PREFIXES = ["ACP_"];

/** True if `key` belongs to the operator's own agent session and must not be inherited by a spawn. */
function isOperatorSessionEnvVar(key: string): boolean {
  return OPERATOR_SESSION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * True if the Claude profile's settings.json defines a custom `ANTHROPIC_BASE_URL` (e.g. z.ai/glm).
 * Such profiles route to a non-Anthropic endpoint that doesn't understand Claude model aliases, so
 * the `--model` flag must be omitted — the profile's own `ANTHROPIC_MODEL` env decides the model.
 */
export function profileDefinesCustomEndpoint(profileName: string | undefined, fs: FileSystem = nodeFileSystem): boolean {
  if (!profileName) return false;
  const settingsPath = join(homedir(), ".claude", `settings_${profileName}.json`);
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const profileSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as ClaudeProfileSettings;
    const env = profileSettings.env;
    return !!(env && typeof env === "object" && env.ANTHROPIC_BASE_URL);
  } catch {
    return false;
  }
}

/**
 * An OAuth (Max/Pro-plan) profile is a whole config DIRECTORY `~/.claude-<name>`, not a
 * `settings_<name>.json` — the login lives in its `.credentials.json`, and the only lever to
 * select it is `CLAUDE_CONFIG_DIR`. Returns that dir when the profile is one, else undefined.
 *
 * Deliberately fs-only (no DB, no rotation ring) so `buildSpawnEnv` stays synchronous and
 * dependency-free; an explicit `configDir` override in the ring is handled by the launch-path
 * resolver, which layers its env on top of this.
 */
function oauthProfileConfigDir(profileName: string, fs: FileSystem): string | undefined {
  if (fs.existsSync(join(homedir(), ".claude", `settings_${profileName}.json`))) return undefined;
  const dir = join(homedir(), `.claude-${profileName}`);
  if (!fs.existsSync(dir)) return undefined;
  const hasAuth = fs.existsSync(join(dir, ".credentials.json")) || fs.existsSync(join(dir, "settings.json"));
  return hasAuth ? dir : undefined;
}

export function buildSpawnEnv(claudeProfile?: string, fs: FileSystem = nodeFileSystem): Record<string, string> {
  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> };

  for (const key of Object.keys(spawnEnv)) {
    if (isProfileOwnedEnvVar(key) || isOperatorSessionEnvVar(key)) delete spawnEnv[key];
  }

  if (!claudeProfile) return spawnEnv;

  // An OAuth profile carries no settings file, so the old code returned here having stripped
  // nothing back in — leaving whatever CLAUDE_CONFIG_DIR the SERVER process inherited. Callers
  // that spawn the CLI get the right dir anyway (the launch path layers it on via extraEnv),
  // but the in-process butler SDK calls this function directly and had no such correction: it
  // reported the selected profile in its status while actually authenticating as the server's
  // ambient account. When that account was logged out, every butler feature failed with
  // "Not logged in · Please run /login" on a board whose configured profile was perfectly valid.
  const oauthDir = oauthProfileConfigDir(claudeProfile, fs);
  if (oauthDir) {
    spawnEnv.CLAUDE_CONFIG_DIR = oauthDir;
    return spawnEnv;
  }

  const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
  if (!fs.existsSync(settingsPath)) return spawnEnv;

  try {
    const profileSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as ClaudeProfileSettings;
    if (profileSettings.env && typeof profileSettings.env === "object") {
      // The strip loop above already removed every profile-owned var (incl. ANTHROPIC_API_KEY)
      // from the inherited server env, so the profile's own env is applied onto a clean slate.
      Object.assign(spawnEnv, profileSettings.env);
    }
  } catch (err) {
    console.warn(`[agent] Failed to read profile env from ${settingsPath}: ${String(err)}`);
  }

  return spawnEnv;
}

// --- Utility functions ---

export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * A flag that must never reach a provider's CLI, declared as data so adding
 * another known-bad flag later is a one-line change (see {@link DENIED_ARGS}).
 */
export interface DeniedFlag {
  /** The exact long-flag token to strip, e.g. "--approve". */
  flag: string;
  /**
   * If true, a separate following value token (`--flag value`) is also stripped.
   * Leave false/undefined for boolean/valueless flags so an unrelated trailing
   * token is NOT swallowed.
   */
  takesValue?: boolean;
  /** Human-readable reason surfaced in the strip warning. */
  reason: string;
}

/**
 * Per-provider denylist of flags that poison a launch. The knowledge that "Pi
 * 0.73.1 rejects --approve" lived ONLY in comments/CLAUDE.md prose, so a stray
 * `--approve` in `agentArgs` (from a pref, stale config, or an agent) silently
 * broke the spawn. Encoding it here — applied in one place by every provider's
 * arg assembly via {@link spliceAgentArgs} — turns that prose into an enforced,
 * extensible invariant. (arch-review §2.2 / ticket #19.)
 */
export const DENIED_ARGS: Record<string, DeniedFlag[]> = {
  pi: [
    {
      flag: "--approve",
      // Pi's approve flag is a valueless boolean; do NOT strip a following token.
      takesValue: false,
      reason: "Pi 0.73.1 rejects --approve and the launch fails outright",
    },
  ],
};

/**
 * Strip any {@link DENIED_ARGS} flags for `providerName` out of an already-split
 * token list, loudly warning (flag + provider + why) for each removal. Handles
 * `--flag`, `--flag=value`, and (for `takesValue` flags) `--flag value`.
 */
export function stripDeniedArgs(providerName: string, tokens: string[]): string[] {
  const denied = DENIED_ARGS[providerName];
  if (!denied || denied.length === 0) return tokens;

  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = denied.find((d) => token === d.flag || token.startsWith(`${d.flag}=`));
    if (!match) {
      result.push(token);
      continue;
    }
    console.warn(
      `[agent] Stripped denied flag "${token}" from ${providerName} agentArgs: ${match.reason}`,
    );
    // Only skip the following token when the flag genuinely takes a separate
    // value AND was passed in the `--flag value` (not `--flag=value`) form.
    if (match.takesValue && token === match.flag && i + 1 < tokens.length) {
      i++;
    }
  }
  return result;
}

/**
 * The single sanctioned entry point for turning a user-supplied `agentArgs`
 * string into spawn tokens: split, then strip this provider's denied flags.
 * Every provider adapter routes `agentArgs` through here so a poison flag can't
 * be spliced in blind on any launch path.
 */
export function spliceAgentArgs(providerName: string, agentArgs: string | undefined): string[] {
  if (!agentArgs) return [];
  return stripDeniedArgs(providerName, splitArgs(agentArgs));
}

export function mapCopilotProfile(profileName: string): { flag: "--model" | "--agent"; value: string } | undefined {
  const agentPrefix = "agent:";
  const modelPrefix = "model:";
  if (profileName === "default") {
    return undefined;
  }
  if (profileName.startsWith(agentPrefix)) {
    return { flag: "--agent", value: profileName.slice(agentPrefix.length) };
  }
  if (profileName.startsWith(modelPrefix)) {
    return { flag: "--model", value: profileName.slice(modelPrefix.length) };
  }
  return { flag: "--model", value: profileName };
}

// --- Windows resolvers ---

export function resolveCodexDirect(command: string, fs: FileSystem = nodeFileSystem): string | undefined {
  if (process.platform !== "win32") return undefined;

  const candidates: string[] = [];
  const base = basename(command).toLowerCase();
  if (base === "codex" || base === "codex.cmd" || base === "codex.ps1") {
    if (command.includes("\\") || command.includes("/")) {
      candidates.push(command);
    } else {
      const extensions = ["", ".cmd", ".ps1"];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of extensions) {
          candidates.push(join(dir, `codex${ext}`));
        }
      }
    }
  }

  for (const candidate of candidates) {
    const entry = join(dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(entry)) return entry;
  }
  return undefined;
}

export function resolveCopilotNpmLoader(command: string, fs: FileSystem = nodeFileSystem): string | undefined {
  if (process.platform !== "win32") return undefined;

  const candidates: string[] = [];
  const base = basename(command).toLowerCase();
  if (base === "copilot" || base === "copilot.cmd" || base === "copilot.ps1") {
    if (command.includes("\\") || command.includes("/")) {
      candidates.push(command);
    } else {
      const extensions = ["", ".cmd", ".ps1"];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of extensions) {
          candidates.push(join(dir, `copilot${ext}`));
        }
      }
    }
  }

  for (const candidate of candidates) {
    const loader = join(dirname(candidate), "node_modules", "@github", "copilot", "npm-loader.js");
    if (fs.existsSync(loader)) return loader;
  }
  return undefined;
}

export function resolvePiExecutable(command: string, fs: FileSystem = nodeFileSystem): string | undefined {
  if (process.platform !== "win32") return undefined;

  const candidates: string[] = [];
  const base = basename(command).toLowerCase();
  if (base !== "pi" && base !== "pi.exe" && base !== "pi.cmd" && base !== "pi.ps1") {
    return undefined;
  }

  if (command.includes("\\") || command.includes("/")) {
    candidates.push(command);
  } else {
    const extensions = [".exe", ".cmd", ".ps1", ""];
    const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const commonDirs = [
      process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "nodejs") : undefined,
      process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs") : undefined,
      process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs") : undefined,
    ].filter((dir): dir is string => !!dir);

    for (const dir of [...pathDirs, ...commonDirs]) {
      for (const ext of extensions) {
        candidates.push(join(dir, `pi${ext}`));
      }
    }
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

// --- Mock-agent launch resolution (#526) -------------------------------------------
//
// All four provider adapters open-coded the same two lines plus the same mock branch,
// and `agent-profile-health.service.ts` sniffed "mock-agent" a fifth way. The risk is
// not the duplication itself but that `isMockAgent` gates whether REAL provider flags
// are added: a copy that drifts sends production arguments to the mock binary, or the
// reverse, and the failure surfaces as an unexplained agent launch failure.

/** Whether a resolved agent command is the mock agent. The single sniff. */
export function isMockAgentCommand(command: string | null | undefined): boolean {
  return (command ?? "").includes("mock-agent");
}

export interface MockLaunchResolution {
  /** True when this launch must use the mock binary's argument shape. */
  isMockAgent: boolean;
  /** The binary to spawn: AGENT_COMMAND override, explicit command, else the default. */
  command: string;
  /**
   * The mock binary's own arguments for this launch. Empty when not mocking, so a
   * caller can splice unconditionally.
   */
  mockArgs: string[];
}

/**
 * Resolve the mock-vs-real launch shape shared by every provider adapter.
 *
 * `AGENT_COMMAND` forces mock mode regardless of the command's name — that is how the
 * E2E harness substitutes the agent — which is why the check is an OR and not just a
 * name sniff.
 */
export function resolveMockLaunch(
  options: { agentCommand?: string | null; providerSessionId?: string | null; keepAlive?: boolean },
  defaultBinary: string,
): MockLaunchResolution {
  const { agentCommand, providerSessionId, keepAlive } = options;
  const agentCommandOverride = readBoardEnv("KANBAN_AGENT_COMMAND");
  const isMockAgent = !!agentCommandOverride || isMockAgentCommand(agentCommand);
  const command = agentCommandOverride || agentCommand || defaultBinary;

  const mockArgs: string[] = [];
  if (isMockAgent) {
    if (providerSessionId) mockArgs.push("--resume", providerSessionId);
    if (keepAlive) mockArgs.push("--profile", "multi-turn");
  }
  return { isMockAgent, command, mockArgs };
}
