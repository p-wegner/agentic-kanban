import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { getMcpConfigPath, buildSpawnEnv, splitArgs, nodeFileSystem, profileDefinesCustomEndpoint } from "./helpers.js";

// --- Stream-event content shapes ---
// Claude assistant/user messages carry a `content` array of typed blocks. These
// interfaces type the boundary so member access on parsed JSON is checked. All
// fields are optional because the shapes are untrusted JSONL from agent stdout.

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeImageSource {
  type?: string;
  data?: string;
  media_type?: string;
}

interface ClaudeToolResultContentBlock {
  type?: string;
  source?: ClaudeImageSource;
}

// --- parseStreamEvent extractors ---
// Each mutates the shared `result` for one Claude stream-event shape. They run in a
// fixed order (see parseStreamEvent) because two `type === "result"` blocks interact
// on liveStats. Kept as small focused mutators to keep parseStreamEvent flat.

function applyClaudeSessionInit(result: ParsedStreamEvent, obj: Record<string, unknown>): void {
  if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
    result.providerSessionId = obj.session_id as string;
  }
}

function applyClaudeResultStats(result: ParsedStreamEvent, obj: Record<string, unknown>, isSubagentMessage: boolean): void {
  if (obj.type !== "result" || isSubagentMessage) return;
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

  const denials = obj.permission_denials as Array<Record<string, unknown>> | undefined;
  if (denials?.some((d) => d.tool_name === "ExitPlanMode")) {
    result.exitPlanModeDenied = true;
  }
}

function applyClaudeAssistantMessage(result: ParsedStreamEvent, obj: Record<string, unknown>, isSubagentMessage: boolean): void {
  if (obj.type !== "assistant" || !obj.message) return;
  const message = obj.message as Record<string, unknown>;
  const usage = message.usage as Record<string, unknown> | undefined;
  const model = (message.model as string) ?? "";
  const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
  const inputTokens = (usage?.input_tokens as number) ?? 0;
  const contextTokens = cacheRead + inputTokens;
  // Only the main agent's context occupancy drives the card's "cx" indicator.
  // A subagent's assistant message reports its own (separate, smaller) context
  // and must not clobber it (#719).
  if (!isSubagentMessage && (model || contextTokens > 0)) {
    result.liveStats = { model, contextTokens };
  }

  const content = message.content;
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  for (const block of content as ClaudeContentBlock[]) {
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && !result.toolActivity) {
      result.toolActivity = {
        name: block.name ?? "",
        input: block.input ?? {},
        toolUseId: block.id,
      };
      if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
        result.todos = (block.input?.todos as Array<{ subject: string; status: string }>).map(
          (t) => ({ subject: t.subject, status: t.status }),
        );
      }
      if (block.name === "Agent") {
        // Track the spawn, but don't let a (nested) subagent message's own
        // context tokens leak in through the fallback (#719).
        result.liveStats = {
          ...(result.liveStats ?? { model: "", contextTokens: 0 }),
          subagentDelta: 1,
        };
      }
    }
  }
  if (textParts.length > 0) {
    result.assistantText = textParts.join("\n");
  }
}

function applyClaudeTaskProgress(result: ParsedStreamEvent, obj: Record<string, unknown>): void {
  if (obj.type === "system" && obj.subtype === "task_progress" && obj.usage) {
    const tpUsage = obj.usage as { tool_uses?: number };
    if (tpUsage.tool_uses) {
      result.liveStats = { model: "", contextTokens: 0, toolUses: tpUsage.tool_uses };
    }
  }
}

function applyClaudeResultUsageLiveStats(result: ParsedStreamEvent, obj: Record<string, unknown>, isSubagentMessage: boolean): void {
  if (obj.type === "result" && obj.usage && !isSubagentMessage) {
    const rUsage = obj.usage as Record<string, unknown>;
    const contextTokens = ((rUsage.cache_read_input_tokens as number) ?? 0) + ((rUsage.input_tokens as number) ?? 0);
    if (contextTokens > 0) {
      result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens }), contextTokens };
    }
  }
}

function applyClaudeToolResult(result: ParsedStreamEvent, obj: Record<string, unknown>): void {
  if (obj.type !== "user" || !(obj.message as Record<string, unknown> | undefined)?.content) return;
  const content = (obj.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const block of content as ClaudeContentBlock[]) {
    if (block.type === "tool_result" && block.tool_use_id) {
      const images: Array<{ mediaType: string; data: string }> = [];
      if (Array.isArray(block.content)) {
        for (const inner of block.content as ClaudeToolResultContentBlock[]) {
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

function applyClaudeRateLimit(result: ParsedStreamEvent, obj: Record<string, unknown>): void {
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
}

function isEmptyClaudeEvent(result: ParsedStreamEvent): boolean {
  return (
    result.providerSessionId === undefined &&
    result.exitPlanModeDenied === undefined &&
    result.stats === undefined &&
    result.turnComplete === undefined &&
    result.liveStats === undefined &&
    result.toolActivity === undefined &&
    result.toolResult === undefined &&
    result.todos === undefined &&
    result.rateLimitInfo === undefined
  );
}

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  readonly profilePrefKey = "claude_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const {
      agentArgs,
      providerSessionId,
      agentCommand,
      claudeProfile,
      profile,
      model,
      keepAlive,
      permissionPromptTool,
      systemInstructions,
      planMode,
      oneShotText,
    } = options;

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

    // One-shot, non-streaming text mode for internal AI utility calls. No
    // stream-json/MCP wiring — just `claude --output-format text -p` reading the
    // prompt from stdin and printing the final answer. This is the launch path
    // `invokeClaudePrompt` used to reimplement outside the provider abstraction.
    if (oneShotText && !isMockAgent) {
      const textArgs: string[] = ["--output-format", "text"];
      if (model && !profileDefinesCustomEndpoint(effectiveProfileName, this.fs)) {
        textArgs.push("--model", model);
      }
      if (effectiveProfileName) {
        const settingsPath = join(homedir(), ".claude", `settings_${effectiveProfileName}.json`);
        if (this.fs.existsSync(settingsPath)) {
          textArgs.push("--settings", settingsPath);
        }
      }
      textArgs.push("-p");
      return {
        command,
        args: textArgs,
        useShell: isWindows && !!agentCommand,
        isMockAgent: false,
        env: buildSpawnEnv(effectiveProfileName, this.fs),
        keepStdinOpen: false,
      };
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
        args.push("--mcp-config", getMcpConfigPath(this.fs));
      } catch (err) {
        console.warn(`[agent] Failed to generate MCP config: ${String(err)}`);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (effectiveProfileName) {
        const settingsPath = join(homedir(), ".claude", `settings_${effectiveProfileName}.json`);
        if (this.fs.existsSync(settingsPath)) {
          args.push("--settings", settingsPath);
        }
      }
      // Pass the selected model tier — but not for profiles routed to a custom endpoint
      // (e.g. z.ai/glm), which don't understand Claude aliases and supply their own model via env.
      if (model && !profileDefinesCustomEndpoint(effectiveProfileName, this.fs)) {
        args.push("--model", model);
      }
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (permissionPromptTool) {
        args.push("--permission-prompt-tool", permissionPromptTool);
      }
      if (systemInstructions) {
        args.push("--append-system-prompt", systemInstructions);
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
      env: buildSpawnEnv(effectiveProfileName, this.fs),
      keepStdinOpen,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    const result: ParsedStreamEvent = {};

    // Subagent (Task/Agent tool) events carry a non-null `parent_tool_use_id`.
    // A subagent runs in its OWN, separate context window — usually much smaller
    // than the main agent's — so its `cache_read + input` token count must NOT
    // overwrite the main session's context-occupancy reading. Otherwise the card's
    // "cx" indicator gets stuck at the subagent's (lower) number while the real
    // usage is higher (#719). We still surface subagent tool activity and text.
    const isSubagentMessage = obj.parent_tool_use_id != null;

    applyClaudeSessionInit(result, obj);
    applyClaudeResultStats(result, obj, isSubagentMessage);
    applyClaudeAssistantMessage(result, obj, isSubagentMessage);
    applyClaudeTaskProgress(result, obj);
    applyClaudeResultUsageLiveStats(result, obj, isSubagentMessage);
    applyClaudeToolResult(result, obj);
    applyClaudeRateLimit(result, obj);

    return isEmptyClaudeEvent(result) ? undefined : result;
  }
}
