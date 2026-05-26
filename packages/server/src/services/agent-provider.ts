import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_PATH = resolve(__dirname, "../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

let claudeMcpConfigPath: string | null = null;

export type ProviderName = "claude" | "codex" | "copilot";
export type ProviderId = "claude-code" | "codex" | "copilot";

/** Sentinel markers wrapping the machine-readable plan block emitted by a plan-mode run. */
export const PLAN_BEGIN_MARKER = "===PLAN BEGIN===";
export const PLAN_END_MARKER = "===PLAN END===";

// --- Provider interface ---

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  env: Record<string, string>;
  /** If true, write prompt to stdin and keep it open for follow-up writes. */
  keepStdinOpen?: boolean;
  /** If true, do not write the prompt to stdin because the provider receives it via argv. */
  suppressStdinPrompt?: boolean;
  /** Prepended to the stdin prompt (used for providers that lack a system-prompt flag, e.g. Codex plan mode). */
  promptPrefix?: string;
}

export interface ProviderLaunchOptions {
  agentArgs?: string;
  providerSessionId?: string;
  agentCommand?: string;
  /** @deprecated Use profile instead — kept for back-compat during migration */
  claudeProfile?: string;
  /** Provider-tagged profile selection (replaces bare claudeProfile string). */
  profile?: { provider: ProviderName; name: string };
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  provider?: ProviderId;
  prompt?: string;
  /** Skip permission prompts (use Copilot --allow-all, Claude system setting). */
  skipPermissions?: boolean;
}

/**
 * Provider-neutral parsed event from a single JSONL line of agent stdout.
 * The session manager uses these to update session state, live stats, and UI.
 */
export interface ParsedStreamEvent {
  /** Set when the provider emits its internal session/resume ID. */
  providerSessionId?: string;
  /** Set when ExitPlanMode was denied in the result event (non-interactive mode). */
  exitPlanModeDenied?: boolean;
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
    images?: Array<{ mediaType: string; data: string }>;
    agentResultText?: string;
  };
  /** Set on assistant events that contain text content. */
  assistantText?: string;
  /** Set on TodoWrite or equivalent task-tracking events. */
  todos?: Array<{ subject: string; status: string }>;
  /** Set on rate_limit_event events. */
  rateLimitInfo?: {
    status: string;
    rateLimitType: string;
    resetsAt?: number;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
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
      profile,
      keepAlive,
      permissionPromptTool,
      planMode,
    } = options;

    // Resolve effective profile name: new `profile` field takes priority, fall back to legacy `claudeProfile`
    const effectiveProfileName = profile?.name ?? claudeProfile;

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
      if (effectiveProfileName) {
        const settingsPath = join(homedir(), ".claude", `settings_${effectiveProfileName}.json`);
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
      env: buildSpawnEnv(effectiveProfileName),
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

      // Detect ExitPlanMode denial (non-interactive mode auto-denies plan exit confirmation)
      const denials = obj.permission_denials as Array<Record<string, unknown>> | undefined;
      if (denials?.some((d) => d.tool_name === "ExitPlanMode")) {
        result.exitPlanModeDenied = true;
      }
    }

    // Assistant event: model + context tokens
    if (obj.type === "assistant" && obj.message) {
      const message = obj.message as Record<string, unknown>;
      const usage = message.usage as Record<string, unknown> | undefined;
      const model = (message.model as string) ?? "";
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const contextTokens = cacheRead + inputTokens;
      if (model || contextTokens > 0) {
        result.liveStats = { model, contextTokens };
      }

      // Text and tool_use blocks from assistant messages
      const content = message.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use" && !result.toolActivity) {
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
          }
        }
        if (textParts.length > 0) {
          result.assistantText = textParts.join("\n");
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
    if (obj.type === "user" && (obj.message as Record<string, unknown> | undefined)?.content) {
      const content = (obj.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const images: Array<{ mediaType: string; data: string }> = [];
            if (Array.isArray(block.content)) {
              for (const inner of block.content) {
                if (inner.type === "image" && inner.source?.type === "base64" && inner.source.data) {
                  images.push({ mediaType: inner.source.media_type ?? "image/png", data: inner.source.data });
                }
              }
            }
            const agentResultText = typeof block.content === "string" && block.content ? block.content : undefined;
            result.toolResult = { toolUseId: block.tool_use_id, ...(images.length > 0 ? { images } : {}), ...(agentResultText !== undefined ? { agentResultText } : {}) };
            break;
          }
        }
      }
    }

    // Rate limit event
    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      const rli = obj.rate_limit_info as Record<string, unknown>;
      result.rateLimitInfo = {
        status: (rli.status as string) ?? "",
        rateLimitType: (rli.rateLimitType as string) ?? "",
        resetsAt: rli.resetsAt as number | undefined,
        overageStatus: rli.overageStatus as string | undefined,
        overageDisabledReason: rli.overageDisabledReason as string | undefined,
        isUsingOverage: rli.isUsingOverage as boolean | undefined,
      };
    }

    // Return undefined if nothing was extracted
    if (
      result.providerSessionId === undefined &&
      result.exitPlanModeDenied === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined &&
      result.todos === undefined &&
      result.rateLimitInfo === undefined
    ) {
      return undefined;
    }

    return result;
  }
}

// --- Codex provider ---

export class CodexProvider implements AgentProvider {
  readonly name = "codex";

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, planMode } = options;
    const isWindows = process.platform === "win32";

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "codex";
    let useShell = isWindows;

    const args: string[] = [];
    let promptPrefix: string | undefined;

    if (isMockAgent) {
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      // On Windows, resolve codex to direct node.exe invocation to avoid needing a shell.
      // The .cmd shim requires shell: true, which prevents detaching (breaks stdout pipes).
      const entry = resolveCodexDirect(command);
      if (entry) {
        args.unshift(entry);
        command = process.execPath;
        useShell = false;
      }

      // Plan mode: run under Codex's read-only sandbox so the agent can read and explore
      // but the sandbox physically blocks file writes and mutating commands — the native
      // equivalent of Claude's plan mode. Otherwise bypass the sandbox for full runs.
      const sandboxFlags = planMode
        ? ["--sandbox", "read-only"]
        : ["--dangerously-bypass-approvals-and-sandbox"];
      // Use `codex exec resume` when resuming a session, otherwise `codex exec`
      if (providerSessionId) {
        args.push("exec", "resume", "--json", ...sandboxFlags, providerSessionId);
      } else {
        args.push("exec", "--json", ...sandboxFlags);
      }
      // Layer named config from $CODEX_HOME/<name>.config.toml on top of base config.
      // "default" means no config layering — use Codex's own defaults without any profile flag.
      const profileName = profile?.provider === "codex" ? profile.name : undefined;
      if (profileName && profileName !== "default") {
        args.push("--profile-v2", profileName);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      // Codex has no --append-system-prompt; convey plan-only intent via the stdin prompt
      // so the agent produces a plan directly instead of repeatedly hitting the sandbox.
      // The sentinel-wrapped block is the machine-readable contract the server parses out
      // and persists as PLAN.md (see PLAN_BEGIN_MARKER / PLAN_END_MARKER).
      if (planMode) {
        promptPrefix = [
          "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files.",
          "Do NOT run commands that make changes (git, npm, pip, etc.). Only read and explore the codebase,",
          "analyze the issue, and produce a detailed implementation plan.",
          "",
          "At the very END of your response, output the complete plan as Markdown wrapped EXACTLY between",
          "these two marker lines, each on its own line with nothing else on the line:",
          PLAN_BEGIN_MARKER,
          "<your full markdown implementation plan here>",
          PLAN_END_MARKER,
          "Then stop.",
        ].join("\n");
      }
      // Prompt is passed via stdin (using `-` as the last argument)
      args.push("-");
    }

    return {
      command,
      args,
      // On Windows, useShell is false when the codex.js entry point was discovered directly,
      // allowing the process to be detached and survive hot-reloads. Falls back to true for
      // .cmd shims when direct resolution fails.
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      promptPrefix,
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

    // thread.started: extract session/thread ID
    if (obj.type === "thread.started" && obj.thread_id) {
      result.providerSessionId = obj.thread_id as string;
    }

    // turn.completed: stats + turn complete
    if (obj.type === "turn.completed") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const cachedTokens = (usage?.cached_input_tokens as number) ?? 0;
      const outputTokens = (usage?.output_tokens as number) ?? 0;
      result.stats = {
        durationMs: 0,
        totalCostUsd: 0,
        inputTokens,
        outputTokens,
        numTurns: 1,
        model: "",
        success: true,
      };
      result.liveStats = {
        model: "",
        contextTokens: inputTokens + cachedTokens,
      };
      result.turnComplete = true;
    }

    // item.started: tool/command activity
    if (obj.type === "item.started" && obj.item) {
      const item = obj.item as Record<string, unknown>;
      if (item.type === "command_execution" && item.command) {
        result.toolActivity = {
          name: "shell",
          input: { command: item.command },
          toolUseId: item.id as string | undefined,
        };
      } else if (item.type === "mcp_tool_call" && item.name) {
        result.toolActivity = {
          name: item.name as string,
          input: (item.args ?? {}) as Record<string, unknown>,
          toolUseId: item.id as string | undefined,
        };
      }
    }

    // item.completed: agent message or tool result
    if (obj.type === "item.completed" && obj.item) {
      const item = obj.item as Record<string, unknown>;
      if (item.type === "command_execution" && item.id) {
        result.toolResult = { toolUseId: item.id as string };
      } else if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
        result.assistantText = item.text;
      } else if (item.type === "mcp_tool_call" && item.id) {
        const resultText = typeof item.result === "string" ? item.result : undefined;
        result.toolResult = {
          toolUseId: item.id as string,
          ...(resultText ? { agentResultText: resultText } : {}),
        };
      }
    }

    if (
      result.providerSessionId === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.assistantText === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined &&
      result.todos === undefined
    ) {
      return undefined;
    }

    return result;
  }
}

// --- Copilot provider ---

const COPILOT_PLAN_PROMPT_PREFIX = [
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

const COPILOT_PLAN_DENIED_TOOLS = [
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

const COPILOT_DEFAULT_ALLOWED_TOOLS = [
  "read",
  "write",
  "search",
  "shell",
  "agentic-kanban",
];

const COPILOT_SESSION_ID_TYPES = new Set([
  "session.start",
  "session.started",
  "session.created",
  "session_start",
  "session_started",
  "session_created",
  "result",
]);

function resolveCodexDirect(command: string): string | undefined {
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
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

function resolveCopilotNpmLoader(command: string): string | undefined {
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
    if (existsSync(loader)) return loader;
  }
  return undefined;
}

export class CopilotProvider implements AgentProvider {
  readonly name = "copilot";

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, planMode, prompt, skipPermissions } = options;
    const isWindows = process.platform === "win32";

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "copilot";
    let useShell = isWindows;
    const argsPrefix: string[] = [];

    const args: string[] = [];
    let promptPrefix: string | undefined;
    let suppressStdinPrompt = false;

    if (isMockAgent) {
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      const loader = resolveCopilotNpmLoader(command);
      if (loader) {
        command = process.execPath;
        argsPrefix.push(loader);
        useShell = false;
      }

      const effectivePrompt = planMode ? `${COPILOT_PLAN_PROMPT_PREFIX}\n\n${prompt ?? ""}` : (prompt ?? "");
      args.push("-p", effectivePrompt);
      suppressStdinPrompt = true;
      args.push("--output-format", "json", "--stream", "on", "--no-ask-user", "--no-color");

      if (providerSessionId) {
        args.push(`--resume=${providerSessionId}`);
      }

      try {
        args.push("--additional-mcp-config", `@${getMcpConfigPath()}`);
      } catch (err) {
        console.warn(`[agent] Failed to generate MCP config: ${err}`);
      }
      args.push("--disable-builtin-mcps");

      const profileName = profile?.provider === "copilot" ? profile.name : undefined;
      if (profileName) {
        const mapped = mapCopilotProfile(profileName);
        if (mapped) {
          args.push(mapped.flag, mapped.value);
        }
      }

      // Skip permission prompts: use --allow-all when enabled. Otherwise,
      // use targeted tool list to avoid permission prompts for known-safe tools.
      if (skipPermissions) {
        args.push("--allow-all");
      } else {
        // Non-interactive Copilot requires explicit tool permissions. Keep this
        // targeted instead of defaulting to --allow-all/--allow-all-tools.
        for (const allowedTool of COPILOT_DEFAULT_ALLOWED_TOOLS) {
          args.push(`--allow-tool=${allowedTool}`);
        }
      }

      if (planMode) {
        args.push("--plan");
        args.push("--available-tools=read,search,shell,agentic-kanban");
        for (const deniedTool of COPILOT_PLAN_DENIED_TOOLS) {
          args.push(`--deny-tool=${deniedTool}`);
        }
      }

      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
    }

    return {
      command,
      args: [...argsPrefix, ...args],
      // On Windows, prefer the Copilot npm loader directly when discoverable.
      // Falling back to the shim requires a shell, which is less reliable for
      // multiline prompts but keeps non-standard installs usable.
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      suppressStdinPrompt,
      promptPrefix,
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
    const type = typeof obj.type === "string" ? obj.type : "";
    const normalized = type.toLowerCase().replace(/-/g, "_");
    const data = objectValue(obj.data);
    const payload = Object.keys(data).length > 0 ? data : obj;

    const sessionId =
      stringValue(payload.session_id) ??
      stringValue(payload.sessionId) ??
      stringValue((payload.session as Record<string, unknown> | undefined)?.id) ??
      (COPILOT_SESSION_ID_TYPES.has(normalized) ? stringValue(obj.id) : undefined);
    if (sessionId) {
      result.providerSessionId = sessionId;
    }

    const model = stringValue(payload.model) ?? stringValue((payload.provider as Record<string, unknown> | undefined)?.model) ?? "";
    const usage = (payload.usage ?? payload.stats) as Record<string, unknown> | undefined;
    const inputTokens = numberValue(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens);
    const cachedTokens = numberValue(usage?.cached_input_tokens ?? usage?.cache_read_input_tokens ?? usage?.cachedInputTokens);
    const outputTokens = numberValue(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens);

    if (inputTokens || cachedTokens || model) {
      result.liveStats = { model, contextTokens: inputTokens + cachedTokens };
    }

    if (type === "result" || type === "turn.completed" || type === "session.completed" || type === "completed") {
      result.stats = {
        durationMs: numberValue(payload.duration_ms ?? payload.durationMs ?? usage?.sessionDurationMs),
        totalCostUsd: numberValue(payload.total_cost_usd ?? payload.cost_usd ?? payload.costUsd),
        inputTokens,
        outputTokens,
        numTurns: numberValue(obj.num_turns ?? obj.numTurns) || 1,
        model,
        success: payload.is_error !== true && payload.error === undefined && (payload.exitCode === undefined || numberValue(payload.exitCode) === 0),
        agentSummary: stringValue(payload.result ?? payload.summary ?? payload.text),
      };
      result.turnComplete = true;
    }

    const item = obj.item as Record<string, unknown> | undefined;
    const toolName = stringValue(payload.tool_name ?? payload.toolName ?? item?.tool_name ?? item?.toolName ?? item?.name);
    if (toolName) {
      result.toolActivity = {
        name: toolName,
        input: objectValue(payload.input ?? payload.arguments ?? item?.input),
        toolUseId: stringValue(payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? item?.id),
      };
    } else if (type.includes("command") || item?.type === "command_execution") {
      const command = stringValue(obj.command ?? item?.command);
      if (command) {
        result.toolActivity = {
          name: "shell",
          input: { command },
          toolUseId: stringValue(obj.id ?? item?.id),
        };
      }
    }

    if (type === "tool.execution_start") {
      result.toolActivity = {
        name: stringValue(payload.toolName) ?? "copilot_tool",
        input: objectValue(payload.arguments),
        toolUseId: stringValue(payload.toolCallId),
      };
    }

    if (type.includes("tool") && (type.includes("completed") || type.includes("result"))) {
      const toolUseId = stringValue(payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? obj.id ?? item?.id);
      if (toolUseId) result.toolResult = { toolUseId };
    } else if (item?.type === "command_execution" && item.id && type.includes("completed")) {
      result.toolResult = { toolUseId: String(item.id) };
    }

    const assistantText = extractCopilotAssistantText(obj);
    if (assistantText) {
      result.assistantText = assistantText;
    }

    if (
      result.providerSessionId === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.assistantText === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined
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
  const key = name === "claude-code" ? "claude" : (name ?? defaultProviderName);
  const provider = providers.get(key);
  if (!provider) throw new Error(`Unknown agent provider: ${key}`);
  return provider;
}

export function setDefaultProvider(name: string): void {
  if (!providers.has(name)) throw new Error(`Unknown agent provider: ${name}`);
  defaultProviderName = name;
}

// Register built-in providers
registerProvider(new ClaudeProvider());
registerProvider(new CodexProvider());
registerProvider(new CopilotProvider());

// --- Backward-compatible entry point ---

export interface BuildAgentLaunchConfigOptions extends ProviderLaunchOptions {}

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  const providerName = options.provider ?? undefined;
  return getProvider(providerName).buildLaunchConfig(options);
}

// --- Internal helpers ---

function getMcpConfigPath(): string {
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

const PROFILE_OWNED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "API_TIMEOUT_MS",
];

export function buildSpawnEnv(claudeProfile?: string): Record<string, string> {
  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> };

  // Always strip these so Claude Code falls back to its stored OAuth credentials.
  // Without this, an ANTHROPIC_API_KEY in the server's env leaks into every spawned
  // agent and causes 401s when the key is wrong/expired.
  for (const key of PROFILE_OWNED_ENV_VARS) {
    delete spawnEnv[key];
  }

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

function mapCopilotProfile(profileName: string): { flag: "--model" | "--agent"; value: string } | undefined {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extractCopilotAssistantText(obj: Record<string, unknown>): string | undefined {
  const data = objectValue(obj.data);
  const payload = Object.keys(data).length > 0 ? data : obj;

  const direct = stringValue(payload.text ?? payload.message ?? payload.response ?? payload.result);
  if (direct) return direct;

  const item = payload.item as Record<string, unknown> | undefined;
  const itemText = stringValue(item?.text ?? item?.message);
  if (itemText) return itemText;

  const content = payload.content ?? item?.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const text = stringValue((block as Record<string, unknown>).text);
        if (text) textParts.push(text);
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }

  return undefined;
}
