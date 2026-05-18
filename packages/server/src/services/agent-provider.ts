import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_PATH = resolve(__dirname, "../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

let mcpConfigPath: string | null = null;

export interface BuildAgentLaunchConfigOptions {
  agentArgs?: string;
  providerSessionId?: string;
  agentCommand?: string;
  claudeProfile?: string;
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
}

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  env: Record<string, string>;
}

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  const {
    agentArgs,
    providerSessionId,
    agentCommand,
    claudeProfile,
    keepAlive,
    permissionPromptTool,
    planMode,
  } = options;

  // Mock agents (env var or preference-based) need no Claude-specific flags.
  // Real Claude (default or configured via preferences) gets stream-json args + stdin prompt.
  const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
  let command = process.env.AGENT_COMMAND || agentCommand || "claude";
  const isWindows = process.platform === "win32";

  // On Windows, resolve .cmd wrappers to the actual .exe to avoid cmd.exe stdout buffering.
  // shell:false is required for real-time stream-json output; cmd.exe buffers everything.
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
      args.push("--mcp-config", getMcpConfigPath());
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
    env: buildSpawnEnv(claudeProfile),
  };
}

function getMcpConfigPath(): string {
  if (mcpConfigPath && existsSync(mcpConfigPath)) return mcpConfigPath;
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
  mcpConfigPath = path;
  console.log(`[agent] MCP config written to ${path}`);
  return path;
}

function buildSpawnEnv(claudeProfile?: string): Record<string, string> {
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
