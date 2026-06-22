import { extname } from "node:path";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { nodeFileSystem, numberValue, objectValue, resolvePiExecutable, splitArgs, stringValue } from "./helpers.js";

function extractPiProfile(profile: ProviderLaunchOptions["profile"]): { provider?: string; model?: string } {
  if (profile?.provider !== "pi") return {};
  const name = profile.name.trim();
  if (!name || name === "default") return {};

  const slash = name.indexOf("/");
  const colon = name.indexOf(":");
  const separator = slash >= 0 ? slash : colon;
  if (separator <= 0 || separator === name.length - 1) {
    return {};
  }

  return {
    provider: name.slice(0, separator),
    model: name.slice(separator + 1),
  };
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string" && content) return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    const record = objectValue(block);
    const text = stringValue(record.text);
    if (record.type === "text" && text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractUsage(message: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  totalCostUsd: number;
} {
  const usage = objectValue(message.usage);
  const cost = objectValue(usage.cost);
  const inputTokens = numberValue(usage.input);
  const outputTokens = numberValue(usage.output);
  const cacheRead = numberValue(usage.cacheRead);
  return {
    inputTokens,
    outputTokens,
    contextTokens: inputTokens + cacheRead,
    totalCostUsd: numberValue(cost.total),
  };
}

function hasParsedFields(result: ParsedStreamEvent): boolean {
  return result.providerSessionId !== undefined ||
    result.stats !== undefined ||
    result.turnComplete !== undefined ||
    result.liveStats !== undefined ||
    result.assistantText !== undefined ||
    result.toolActivity !== undefined ||
    result.toolResult !== undefined ||
    result.rateLimitInfo !== undefined;
}

// --- parseStreamEvent extractors ---
// Each mutates the shared `result` for one Pi stream-event shape. parseStreamEvent
// runs them in order; types are disjoint enough that ordering only matters where a
// block both sets liveStats and stats on turn_end (live stats first, then stats).

function applyPiSession(result: ParsedStreamEvent, type: string | undefined, obj: Record<string, unknown>): void {
  if (type !== "session") return;
  const sessionId = stringValue(obj.id);
  if (sessionId) result.providerSessionId = sessionId;
}

function applyPiMessageUpdate(result: ParsedStreamEvent, type: string | undefined, assistantEvent: Record<string, unknown>): void {
  if (type !== "message_update") return;
  if (assistantEvent.type === "text_delta") {
    const text = stringValue(assistantEvent.delta);
    if (text) result.assistantText = text;
  } else if (assistantEvent.type === "text_start" || assistantEvent.type === "text_end") {
    const text = stringValue(assistantEvent.content);
    if (text) result.assistantText = text;
  } else if (assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_end") {
    let toolCall = objectValue(assistantEvent.toolCall);
    if (Object.keys(toolCall).length === 0) {
      const partialContent = objectValue(assistantEvent.partial).content;
      if (Array.isArray(partialContent)) {
        toolCall = objectValue(partialContent[0]);
      }
    }
    const name = stringValue(toolCall.name);
    if (name) {
      result.toolActivity = {
        name,
        input: objectValue(toolCall.arguments),
        toolUseId: stringValue(toolCall.id),
      };
    }
  }
}

function applyPiMessageBoundary(result: ParsedStreamEvent, type: string | undefined, message: Record<string, unknown>): void {
  if (type !== "message_start" && type !== "message_end") return;
  if (message.role === "toolResult") {
    const toolUseId = stringValue(message.toolCallId);
    if (toolUseId) {
      const resultText = extractContentText(message.content);
      result.toolResult = {
        toolUseId,
        ...(resultText ? { agentResultText: resultText } : {}),
      };
    }
  } else if (message.role === "assistant") {
    const text = extractContentText(message.content);
    if (text) result.assistantText = text;
  }
}

function applyPiToolExecution(result: ParsedStreamEvent, type: string | undefined, obj: Record<string, unknown>): void {
  if (type === "tool_execution_start") {
    const name = stringValue(obj.toolName);
    if (name) {
      result.toolActivity = {
        name,
        input: objectValue(obj.args),
        toolUseId: stringValue(obj.toolCallId),
      };
    }
  }

  if (type === "tool_execution_end") {
    const toolUseId = stringValue(obj.toolCallId);
    if (toolUseId) {
      const resultText = extractContentText(objectValue(obj.result).content);
      result.toolResult = {
        toolUseId,
        ...(resultText ? { agentResultText: resultText } : {}),
      };
    }
  }
}

function applyPiLiveStats(result: ParsedStreamEvent, type: string | undefined, message: Record<string, unknown>): void {
  if ((type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end") && Object.keys(message).length > 0) {
    const model = stringValue(message.model) ?? "";
    const usage = extractUsage(message);
    if (model || usage.contextTokens > 0) {
      result.liveStats = { model, contextTokens: usage.contextTokens };
    }
  }
}

function applyPiTurnEnd(result: ParsedStreamEvent, type: string | undefined, message: Record<string, unknown>, obj: Record<string, unknown>): void {
  if (type !== "turn_end") return;
  const usageMessage = Object.keys(message).length > 0 ? message : objectValue(obj.message);
  const usage = extractUsage(usageMessage);
  result.stats = {
    durationMs: 0,
    totalCostUsd: usage.totalCostUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens: usage.contextTokens,
    numTurns: 1,
    model: stringValue(usageMessage.model) ?? "",
    success: usageMessage.stopReason !== "error",
    agentSummary: extractContentText(usageMessage.content),
  };
  result.turnComplete = true;

  if (usageMessage.stopReason === "error") {
    const errorMessage = stringValue(usageMessage.errorMessage);
    if (errorMessage && /rate.?limit|usage.?limit|quota/i.test(errorMessage)) {
      result.rateLimitInfo = {
        status: "limited",
        rateLimitType: "usage_limit",
        message: errorMessage,
      };
    }
  }
}

function applyPiRateLimit(result: ParsedStreamEvent, type: string | undefined, obj: Record<string, unknown>): void {
  if (type !== "rate_limit_event" && type !== "rate_limit") return;
  const info = objectValue(obj.rate_limit_info ?? obj.rateLimitInfo ?? obj);
  result.rateLimitInfo = {
    status: stringValue(info.status) ?? "limited",
    rateLimitType: stringValue(info.rateLimitType ?? info.rate_limit_type) ?? "usage_limit",
    resetsAt: numberValue(info.resetsAt ?? info.resets_at) || undefined,
    retryAfter: stringValue(info.retryAfter ?? info.retry_after),
    message: stringValue(info.message),
    overageStatus: stringValue(info.overageStatus),
    overageDisabledReason: stringValue(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
  };
}

export class PiProvider implements AgentProvider {
  readonly name = "pi";
  readonly profilePrefKey = "pi_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, agentCommand, keepAlive, model, piExtensionPaths, piSkillPaths, planMode, profile, providerSessionId, prompt, systemInstructions } = options;
    const isWindows = process.platform === "win32";
    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "pi";
    let useShell = isWindows;

    const args: string[] = [];
    let promptPrefix: string | undefined;
    let suppressStdinPrompt = false;

    if (isMockAgent) {
      if (providerSessionId) args.push("--resume", providerSessionId);
      if (keepAlive) args.push("--profile", "multi-turn");
    } else {
      if (!agentCommand) {
        const resolved = resolvePiExecutable(command, this.fs);
        if (resolved) {
          command = resolved;
          const ext = extname(resolved).toLowerCase();
          useShell = ext === ".cmd" || ext === ".ps1";
        }
      }

      args.push("--mode", "json");

      const piProfile = extractPiProfile(profile);
      if (piProfile.provider) {
        args.push("--provider", piProfile.provider);
      }

      const effectiveModel = model ?? piProfile.model;
      if (effectiveModel) {
        args.push("--model", effectiveModel);
      }

      if (providerSessionId) {
        args.push("--session", providerSessionId);
      }

      for (const extensionPath of piExtensionPaths ?? []) {
        if (extensionPath) args.push("--extension", extensionPath);
      }

      for (const skillPath of piSkillPaths ?? []) {
        if (skillPath) args.push("--skill", skillPath);
      }

      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }

      if (planMode) {
        promptPrefix = [
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
      }
      if (systemInstructions) {
        promptPrefix = promptPrefix ? `${systemInstructions}\n\n${promptPrefix}` : systemInstructions;
      }

      const promptArg = promptPrefix ? `${promptPrefix}\n\n${prompt ?? ""}` : (prompt ?? "");
      args.push("-p", promptArg);
      promptPrefix = undefined;
      suppressStdinPrompt = true;
    }

    return {
      command,
      args,
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
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    const result: ParsedStreamEvent = {};
    const type = stringValue(obj.type);
    const message = objectValue(obj.message);
    const assistantEvent = objectValue(obj.assistantMessageEvent);

    applyPiSession(result, type, obj);
    applyPiMessageUpdate(result, type, assistantEvent);
    applyPiMessageBoundary(result, type, message);
    applyPiToolExecution(result, type, obj);
    applyPiLiveStats(result, type, message);
    applyPiTurnEnd(result, type, message, obj);
    applyPiRateLimit(result, type, obj);

    return hasParsedFields(result) ? result : undefined;
  }
}
