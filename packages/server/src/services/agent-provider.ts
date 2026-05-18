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

// --- Provider interface ---

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  env: Record<string, string>;
  /** If true, write prompt to stdin and keep it open for follow-up writes. */
  keepStdinOpen?: boolean;
}

export interface ProviderLaunchOptions {
  agentArgs?: string;
  providerSessionId?: string;
  agentCommand?: string;
  claudeProfile?: string;
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
}

/**
 * Provider-neutral parsed event from a single JSONL line of agent stdout.
 * The session manager uses these to update session state, live stats, and UI.
 */
export interface ParsedStreamEvent {
  /** Set when the provider emits its internal session/resume ID. */
  providerSessionId?: string;
  /** Set on result/final events with aggregate usage. */
  stats?: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    model: string;
    success: boolean;
    agentSummary?: string;
  };
  /** Set when a result event signals turn completion (multi-turn mode). */
  turnComplete?: boolean;
  /** Set on assistant events with model/context info. */
  liveStats?: {
    model: string;
    contextTokens: number;
    toolUses?: number;
    subagentDelta?: number;
  };
  /** Set on tool_use events. */
  toolActivity?: {
    name: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  };
  /** Set on tool_result events for tracked tool_use IDs. */
  toolResult?: {
    toolUseId: string;
  };
  /** Set on TodoWrite or equivalent task-tracking events. */
  todos?: Array<{ subject: string; status: string }>;
}

export interface AgentProvider {
  readonly name: string;

  /** Build the full spawn configuration for this provider. */
  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig;

  /** Parse a single stdout line into a provider-neutral event (or undefined if not recognized). */
  parseStreamEvent(line: string): ParsedStreamEvent | undefined;
}

// --- Claude provider ---

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const {
      agentArgs,
      providerSessionId,
      agentCommand,
      claudeProfile,
      keepAlive,
      permissionPromptTool,
      planMode,
    } = options;

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "claude";
    const isWindows = process.platform === "win32";

    if (isWindows && !isMockAgent && !agentCommand) {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) command = resolved;
      } catch {}
    }

    let args: string[];
    let keepStdinOpen = false;

    if (isMockAgent) {
      args = [];
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
        keepStdinOpen = true;
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
      keepStdinOpen,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return undefined;
    }

    const result: ParsedStreamEvent = {};

    // Provider session ID from init event
    if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
      result.providerSessionId = obj.session_id as string;
    }

    // Result event: stats + turn completion
    if (obj.type === "result") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const rawCost = obj.total_cost_usd ?? obj.cost_usd;
      const agentSummary = typeof obj.result === "string" ? obj.result : undefined;
      result.stats = {
        durationMs: (obj.duration_ms as number) ?? 0,
        totalCostUsd: typeof rawCost === "number" ? rawCost : 0,
        inputTokens: (usage?.input_tokens as number) ?? 0,
        outputTokens: (usage?.output_tokens as number) ?? 0,
        numTurns: (obj.num_turns as number) ?? 1,
        model: (obj.model as string) ?? "",
        success: obj.subtype === "success" && !obj.is_error,
        agentSummary,
      };
      result.turnComplete = true;
    }

    // Assistant event: model + context tokens
    if (obj.type === "assistant" && obj.message) {
      const usage = obj.message.usage as Record<string, unknown> | undefined;
      const model = (obj.message.model as string) ?? "";
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const contextTokens = cacheRead + inputTokens;
      if (model || contextTokens > 0) {
        result.liveStats = { model, contextTokens };
      }

      // Tool use blocks
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            result.toolActivity = {
              name: block.name,
              input: block.input ?? {},
              toolUseId: block.id,
            };
            // TodoWrite: extract todos directly
            if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
              result.todos = (block.input.todos as Array<{ subject: string; status: string }>).map(
                (t) => ({ subject: t.subject, status: t.status }),
              );
            }
            // Agent tool_use: increment subagent count
            if (block.name === "Agent") {
              result.liveStats = {
                ...(result.liveStats ?? { model, contextTokens }),
                subagentDelta: 1,
              };
            }
            break; // one tool_activity per parsed event
          }
        }
      }
    }

    // task_progress: tool_uses count
    if (obj.type === "system" && obj.subtype === "task_progress" && obj.usage) {
      const tpUsage = obj.usage as { tool_uses?: number };
      if (tpUsage.tool_uses) {
        result.liveStats = { model: "", contextTokens: 0, toolUses: tpUsage.tool_uses };
      }
    }

    // Result event live stats (final context tokens)
    if (obj.type === "result" && obj.usage) {
      const rUsage = obj.usage as Record<string, unknown>;
      const contextTokens = ((rUsage.cache_read_input_tokens as number) ?? 0) + ((rUsage.input_tokens as number) ?? 0);
      if (contextTokens > 0) {
        result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens: 0 }), contextTokens };
      }
    }

    // User message with tool_result: check for Agent tool_use ID
    if (obj.type === "user" && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            result.toolResult = { toolUseId: block.tool_use_id };
            break;
          }
        }
      }
    }

    // TaskCreate/TaskUpdate (only used when no TodoWrite has been seen — caller decides)
    if (obj.type === "assistant" && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "TaskCreate" && block.input?.subject) {
            // Signal a single task creation — caller accumulates
            if (!result.todos) result.todos = [];
            result.todos.push({ subject: block.input.subject as string, status: "pending" });
          }
          if (block.type === "tool_use" && block.name === "TaskUpdate" && block.input?.taskId && block.input?.status) {
            // TaskUpdate doesn't map cleanly to ParsedStreamEvent.todos
            // The session manager handles this directly
          }
        }
      }
    }

    // Return undefined if nothing was extracted
    if (
      result.providerSessionId === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined &&
      result.todos === undefined
    ) {
      return undefined;
    }

    return result;
  }
}

// --- Provider registry ---

const providers = new Map<string, AgentProvider>();
let defaultProviderName = "claude";

function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name?: string): AgentProvider {
  const provider = providers.get(name ?? defaultProviderName);
  if (!provider) throw new Error(`Unknown agent provider: ${name ?? defaultProviderName}`);
  return provider;
}

export function setDefaultProvider(name: string): void {
  if (!providers.has(name)) throw new Error(`Unknown agent provider: ${name}`);
  defaultProviderName = name;
}

// Register built-in providers
registerProvider(new ClaudeProvider());

// --- Backward-compatible entry point ---

export interface BuildAgentLaunchConfigOptions extends ProviderLaunchOptions {}

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  return getProvider().buildLaunchConfig(options);
}

// --- Internal helpers ---

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
