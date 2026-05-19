import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_PATH = resolve(__dirname, "../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

let claudeMcpConfigPath: string | null = null;

export type ProviderId = "claude-code" | "codex";

export interface BuildAgentLaunchConfigOptions {
  agentArgs?: string;
  providerSessionId?: string;
  agentCommand?: string;
  claudeProfile?: string;
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  provider?: ProviderId;
  prompt?: string;
}

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  isStdinPrompt: boolean;
  env: Record<string, string>;
}

// --- Provider interface ---

export interface AgentProvider {
  id: ProviderId;
  label: string;

  buildLaunchConfig(opts: BuildAgentLaunchConfigOptions & { isWindows: boolean }): AgentLaunchConfig;
}

// --- Claude Code provider ---

const claudeProvider: AgentProvider = {
  id: "claude-code",
  label: "Claude Code",

  buildLaunchConfig({ agentArgs, providerSessionId, agentCommand, claudeProfile, keepAlive, permissionPromptTool, planMode, isWindows }) {
    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "claude";

    // On Windows, resolve .cmd wrappers to the actual .exe to avoid cmd.exe stdout buffering.
    if (isWindows && !isMockAgent && !agentCommand) {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) command = resolved;
      } catch {}
    }

    let args: string[];
    if (isMockAgent) {
      args = [];
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      args = ["--output-format", "stream-json", "--verbose"];
      try {
        args.push("--mcp-config", getClaudeMcpConfigPath());
      } catch (err) {
        console.warn(`[agent] Failed to generate MCP config: ${err}`);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (claudeProfile) {
        const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
        if (existsSync(settingsPath)) {
          args.push("--settings", settingsPath);
        }
      }
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (permissionPromptTool) {
        args.push("--permission-prompt-tool", permissionPromptTool);
      }
      if (planMode) {
        args.push("--permission-mode", "plan");
        args.push("--append-system-prompt", "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files. Do NOT run commands that make changes (git, npm, pip, etc.). Only read and explore the codebase, analyze the issue, and produce a detailed implementation plan. Output your plan and stop.");
      }
      args.push("-p");
    }

    return {
      command,
      args,
      useShell: isWindows && (isMockAgent || !!agentCommand),
      isMockAgent,
      isStdinPrompt: !isMockAgent || !!keepAlive,
      env: buildClaudeSpawnEnv(claudeProfile),
    };
  },
};

// --- Codex provider ---

const codexProvider: AgentProvider = {
  id: "codex",
  label: "Codex",

  buildLaunchConfig({ agentArgs, providerSessionId, agentCommand, keepAlive, planMode, prompt, isWindows }) {
    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "codex";

    // On Windows, resolve .cmd wrappers to the actual .exe
    if (isWindows && !isMockAgent && !agentCommand) {
      try {
        const resolved = execSync("where codex.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) command = resolved;
      } catch {}
    }

    // Set CODEX_HOME to temp dir with our MCP config.toml
    const codexHome = getCodexHome();
    const env: Record<string, string> = { ...process.env as Record<string, string>, CODEX_HOME: codexHome };

    let args: string[];
    if (isMockAgent) {
      args = [];
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      // codex exec --json [flags] -- <prompt>
      // codex exec resume <session_id> <prompt>
      if (providerSessionId) {
        args = ["exec", "resume", providerSessionId];
      } else {
        args = ["exec", "--json"];
      }

      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (planMode) {
        args.push("--sandbox", "read-only");
      } else {
        args.push("--sandbox", "workspace-write");
      }
      args.push("--ask-for-approval", "never");

      // Positional prompt after -- separator (not for resume, which takes prompt as arg)
      if (prompt) {
        if (providerSessionId) {
          args.push(prompt);
        } else {
          args.push("--", prompt);
        }
      } else if (!providerSessionId) {
        args.push("--", "");
      }
    }

    return {
      command,
      args,
      useShell: isWindows && (isMockAgent || !!agentCommand),
      isMockAgent,
      isStdinPrompt: isMockAgent && !!keepAlive,
      env,
    };
  },
};

// --- Provider registry ---

const providers: Map<ProviderId, AgentProvider> = new Map([
  ["claude-code", claudeProvider],
  ["codex", codexProvider],
]);

export function getProvider(id: ProviderId): AgentProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown agent provider: ${id}`);
  return provider;
}

export function resolveProvider(agentCommand?: string, providerId?: ProviderId): AgentProvider {
  // Explicit provider takes priority
  if (providerId) return getProvider(providerId);
  // Detect from agent command
  if (agentCommand?.includes("codex") || agentCommand?.includes("Codex")) return codexProvider;
  // Default: Claude Code
  return claudeProvider;
}

// --- Main entry point (backward-compatible) ---

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  const { agentCommand, provider: providerId } = options;
  const provider = resolveProvider(agentCommand, providerId);
  return provider.buildLaunchConfig({ ...options, isWindows: process.platform === "win32" });
}

// --- MCP config helpers ---

function getClaudeMcpConfigPath(): string {
  if (claudeMcpConfigPath && existsSync(claudeMcpConfigPath)) return claudeMcpConfigPath;
  const config = {
    mcpServers: {
      "agentic-kanban": {
        command: "node",
        args: ["--import", TSX_URL, MCP_SERVER_PATH],
      },
    },
  };
  const path = resolve(tmpdir(), "agentic-kanban-mcp-config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  claudeMcpConfigPath = path;
  console.log(`[agent] Claude MCP config written to ${path}`);
  return path;
}

let codexHome: string | null = null;

function getCodexHome(): string {
  if (codexHome && existsSync(join(codexHome, "config.toml"))) return codexHome;
  // Create a temp CODEX_HOME with config.toml containing MCP server
  const home = resolve(tmpdir(), "agentic-kanban-codex-home");
  mkdirSync(home, { recursive: true });
  // Use forward slashes for MCP_SERVER_PATH — TOML double-quoted strings treat \ as escape
  const safePath = MCP_SERVER_PATH.replace(/\\/g, "/");
  const config = `# Auto-generated by agentic-kanban
[mcp_servers.agentic-kanban]
command = "node"
args = ["--import", "${TSX_URL}", "${safePath}"]
default_tools_approval_mode = "approve"
`;
  writeFileSync(join(home, "config.toml"), config, "utf-8");
  codexHome = home;
  console.log(`[agent] Codex home written to ${home}`);
  return home;
}

// --- Claude profile env helper ---

function buildClaudeSpawnEnv(claudeProfile?: string): Record<string, string> {
  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (!claudeProfile) return spawnEnv;

  const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
  if (!existsSync(settingsPath)) return spawnEnv;

  try {
    const profileSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (profileSettings.env && typeof profileSettings.env === "object") {
      const profileEnv = profileSettings.env as Record<string, string>;
      if (profileEnv.ANTHROPIC_AUTH_TOKEN && !profileEnv.ANTHROPIC_API_KEY) {
        delete spawnEnv.ANTHROPIC_API_KEY;
      }
      Object.assign(spawnEnv, profileEnv);
    }
  } catch (err) {
    console.warn(`[agent] Failed to read profile env from ${settingsPath}: ${err}`);
  }

  return spawnEnv;
}

// --- Utility ---

function splitArgs(input: string): string[] {
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
