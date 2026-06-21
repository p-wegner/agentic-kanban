import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { resolveCodexDirect, splitArgs, nodeFileSystem } from "./helpers.js";
import { detectCodexUsageLimitText } from "../codex-rate-limit.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** thread.started carries the Codex thread id used as the provider session id. */
function extractCodexSessionId(obj: Record<string, unknown>): string | undefined {
  if (obj.type === "thread.started" && obj.thread_id) {
    return obj.thread_id as string;
  }
  return undefined;
}

/** Any event may carry a usage-limit message (top-level or under `error`). */
function buildCodexRateLimit(obj: Record<string, unknown>): ParsedStreamEvent["rateLimitInfo"] | undefined {
  const error = asRecord(obj.error);
  const message = typeof obj.message === "string"
    ? obj.message
    : typeof error?.message === "string"
      ? error.message
      : undefined;
  const usageLimit = detectCodexUsageLimitText(message);
  if (!usageLimit) return undefined;
  return {
    status: "limited",
    rateLimitType: "usage_limit",
    retryAfter: usageLimit.retryAfter ?? undefined,
    message: usageLimit.message,
  };
}

/** turn.completed reports token usage; context display prefers last-turn over cumulative. */
function buildCodexTurnStats(obj: Record<string, unknown>):
  { stats: NonNullable<ParsedStreamEvent["stats"]>; liveStats: NonNullable<ParsedStreamEvent["liveStats"]> } | undefined {
  if (obj.type !== "turn.completed") return undefined;
  const usage = asRecord(obj.usage);
  const totalUsage = asRecord(usage?.total_token_usage) ?? usage;
  const currentUsage = asRecord(usage?.last_token_usage) ?? asRecord(obj.last_token_usage) ?? usage;
  const inputTokens = numberValue(totalUsage?.input_tokens);
  const outputTokens = numberValue(totalUsage?.output_tokens);
  const contextTokens = numberValue(currentUsage?.input_tokens) || inputTokens;
  return {
    stats: {
      durationMs: 0,
      totalCostUsd: 0,
      inputTokens,
      outputTokens,
      contextTokens,
      numTurns: 1,
      model: "",
      success: true,
    },
    liveStats: {
      model: "",
      contextTokens,
    },
  };
}

/** item.started announces a shell command or MCP tool call in flight. */
function extractCodexToolActivity(obj: Record<string, unknown>): ParsedStreamEvent["toolActivity"] | undefined {
  if (obj.type !== "item.started" || !obj.item) return undefined;
  const item = obj.item as Record<string, unknown>;
  if (item.type === "command_execution" && item.command) {
    return {
      name: "shell",
      input: { command: item.command },
      toolUseId: item.id as string | undefined,
    };
  }
  if (item.type === "mcp_tool_call" && item.name) {
    return {
      name: item.name as string,
      input: (item.args ?? {}) as Record<string, unknown>,
      toolUseId: item.id as string | undefined,
    };
  }
  return undefined;
}

/** item.completed yields either a tool result (shell/MCP) or the agent's message text. */
function extractCodexItemResult(obj: Record<string, unknown>): Pick<ParsedStreamEvent, "toolResult" | "assistantText"> | undefined {
  if (obj.type !== "item.completed" || !obj.item) return undefined;
  const item = obj.item as Record<string, unknown>;
  if (item.type === "command_execution" && item.id) {
    return { toolResult: { toolUseId: item.id as string } };
  }
  if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
    return { assistantText: item.text };
  }
  if (item.type === "mcp_tool_call" && item.id) {
    const resultText = typeof item.result === "string" ? item.result : undefined;
    return {
      toolResult: {
        toolUseId: item.id as string,
        ...(resultText ? { agentResultText: resultText } : {}),
      },
    };
  }
  return undefined;
}

/** True when no field of a parsed event was populated — the line carried nothing useful. */
function isEmptyParsedEvent(result: ParsedStreamEvent): boolean {
  return (
    result.providerSessionId === undefined &&
    result.stats === undefined &&
    result.turnComplete === undefined &&
    result.liveStats === undefined &&
    result.assistantText === undefined &&
    result.toolActivity === undefined &&
    result.toolResult === undefined &&
    result.todos === undefined &&
    result.rateLimitInfo === undefined
  );
}

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  readonly profilePrefKey = "codex_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, model, planMode, systemInstructions } = options;
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
      const entry = resolveCodexDirect(command, this.fs);
      if (entry) {
        args.unshift(entry);
        command = process.execPath;
        useShell = false;
      }

      const hookTrustFlags = ["--dangerously-bypass-hook-trust"];
      const sandboxFlags = planMode
        ? ["--sandbox", "read-only", ...hookTrustFlags]
        : ["--dangerously-bypass-approvals-and-sandbox", ...hookTrustFlags];
      const profileName = profile?.provider === "codex" ? profile.name : undefined;
      // All `codex exec` options (--json, sandbox, --profile, --model, extra args)
      // MUST precede the `resume` subcommand. `codex exec resume` does not accept
      // --profile/--model and exits with code 2 ("unexpected argument") if they
      // appear after `resume`, so build the exec flags first, then the subcommand.
      args.push("exec", "--json", ...sandboxFlags);
      if (profileName && profileName !== "default") {
        args.push("--profile", profileName);
      }
      if (model) {
        args.push("--model", model);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (providerSessionId) {
        args.push("resume", providerSessionId);
      }
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
      } else if (systemInstructions) {
        promptPrefix = systemInstructions;
      }
      if (planMode && systemInstructions) {
        promptPrefix = `${systemInstructions}\n\n${promptPrefix}`;
      }
      args.push("-");
    }

    return {
      command,
      args,
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

    const providerSessionId = extractCodexSessionId(obj);
    if (providerSessionId) result.providerSessionId = providerSessionId;

    const rateLimitInfo = buildCodexRateLimit(obj);
    if (rateLimitInfo) result.rateLimitInfo = rateLimitInfo;

    const turn = buildCodexTurnStats(obj);
    if (turn) {
      result.stats = turn.stats;
      result.liveStats = turn.liveStats;
      result.turnComplete = true;
    }

    const toolActivity = extractCodexToolActivity(obj);
    if (toolActivity) result.toolActivity = toolActivity;

    const itemResult = extractCodexItemResult(obj);
    if (itemResult?.toolResult) result.toolResult = itemResult.toolResult;
    if (itemResult?.assistantText) result.assistantText = itemResult.assistantText;

    return isEmptyParsedEvent(result) ? undefined : result;
  }
}
