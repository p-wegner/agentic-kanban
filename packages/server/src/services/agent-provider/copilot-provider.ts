import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import {
  COPILOT_PLAN_PROMPT_PREFIX,
  COPILOT_PLAN_DENIED_TOOLS,
  COPILOT_DEFAULT_ALLOWED_TOOLS,
  COPILOT_SESSION_ID_TYPES,
  resolveCopilotNpmLoader,
  getMcpConfigPath,
  splitArgs,
  mapCopilotProfile,
  extractCopilotAssistantText,
  stringValue,
  numberValue,
  objectValue,
  nodeFileSystem,
} from "./helpers.js";

/** Token/model bundle shared by the live-stats and turn-completion extractors. */
interface CopilotTokenBundle {
  usage: Record<string, unknown> | undefined;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  model: string;
}

function extractCopilotTokens(payload: Record<string, unknown>): CopilotTokenBundle {
  const usage = (payload.usage ?? payload.stats) as Record<string, unknown> | undefined;
  const inputTokens = numberValue(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens);
  const cachedTokens = numberValue(usage?.cached_input_tokens ?? usage?.cache_read_input_tokens ?? usage?.cachedInputTokens);
  const outputTokens = numberValue(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens);
  const model = stringValue(payload.model) ?? stringValue((payload.provider as Record<string, unknown> | undefined)?.model) ?? "";
  return { usage, inputTokens, cachedTokens, outputTokens, model };
}

function extractCopilotSessionId(
  obj: Record<string, unknown>,
  normalized: string,
  payload: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(payload.session_id) ??
    stringValue(payload.sessionId) ??
    stringValue((payload.session as Record<string, unknown> | undefined)?.id) ??
    (COPILOT_SESSION_ID_TYPES.has(normalized) ? stringValue(obj.id) : undefined)
  );
}

function buildCopilotLiveStats(tokens: CopilotTokenBundle): ParsedStreamEvent["liveStats"] | undefined {
  const { model, inputTokens, cachedTokens } = tokens;
  if (inputTokens || cachedTokens || model) {
    return { model, contextTokens: inputTokens + cachedTokens };
  }
  return undefined;
}

function buildCopilotStats(
  obj: Record<string, unknown>,
  type: string,
  payload: Record<string, unknown>,
  tokens: CopilotTokenBundle,
): ParsedStreamEvent["stats"] | undefined {
  if (type !== "result" && type !== "turn.completed" && type !== "session.completed" && type !== "completed") {
    return undefined;
  }
  const { usage, inputTokens, outputTokens, model } = tokens;
  return {
    durationMs: numberValue(payload.duration_ms ?? payload.durationMs ?? usage?.sessionDurationMs),
    totalCostUsd: numberValue(payload.total_cost_usd ?? payload.cost_usd ?? payload.costUsd),
    inputTokens,
    outputTokens,
    numTurns: numberValue(obj.num_turns ?? obj.numTurns) || 1,
    model,
    success: payload.is_error !== true && payload.error === undefined && numberValue(payload.exitCode) === 0,
    agentSummary: stringValue(payload.result ?? payload.summary ?? payload.text),
  };
}

function extractCopilotToolActivity(
  obj: Record<string, unknown>,
  type: string,
  payload: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): ParsedStreamEvent["toolActivity"] | undefined {
  let activity: ParsedStreamEvent["toolActivity"] | undefined;
  const toolName = stringValue(payload.tool_name ?? payload.toolName ?? item?.tool_name ?? item?.toolName ?? item?.name);
  if (toolName) {
    activity = {
      name: toolName,
      input: objectValue(payload.input ?? payload.arguments ?? item?.input),
      toolUseId: stringValue(payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? item?.id),
    };
  } else if (type.includes("command") || item?.type === "command_execution") {
    const command = stringValue(obj.command ?? item?.command);
    if (command) {
      activity = {
        name: "shell",
        input: { command },
        toolUseId: stringValue(obj.id ?? item?.id),
      };
    }
  }

  // tool.execution_start carries its own canonical shape and overrides the above.
  if (type === "tool.execution_start") {
    activity = {
      name: stringValue(payload.toolName) ?? "copilot_tool",
      input: objectValue(payload.arguments),
      toolUseId: stringValue(payload.toolCallId),
    };
  }

  return activity;
}

function extractCopilotToolResult(
  obj: Record<string, unknown>,
  type: string,
  payload: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): ParsedStreamEvent["toolResult"] | undefined {
  if (type.includes("tool") && (type.includes("completed") || type.includes("result"))) {
    const toolUseId = stringValue(payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? obj.id ?? item?.id);
    if (toolUseId) return { toolUseId };
  } else if (item?.type === "command_execution" && item.id && type.includes("completed")) {
    return { toolUseId: String(item.id) };
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
    result.toolResult === undefined
  );
}

export class CopilotProvider implements AgentProvider {
  readonly name = "copilot";
  readonly profilePrefKey = "copilot_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, planMode, prompt, contextFiles, skipPermissions, systemInstructions } = options;
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
      const loader = resolveCopilotNpmLoader(command, this.fs);
      if (loader) {
        command = process.execPath;
        argsPrefix.push(loader);
        useShell = false;
      }

      const effectivePrompt = [
        systemInstructions,
        planMode ? COPILOT_PLAN_PROMPT_PREFIX : undefined,
        prompt,
      ].filter(Boolean).join("\n\n");
      args.push("-p", effectivePrompt);
      suppressStdinPrompt = true;
      args.push("--output-format", "json", "--stream", "on", "--no-ask-user", "--no-color");
      for (const file of contextFiles ?? []) {
        args.push("--attachment", file);
      }

      if (providerSessionId) {
        args.push(`--resume=${providerSessionId}`);
      }

      try {
        args.push("--additional-mcp-config", `@${getMcpConfigPath(this.fs)}`);
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

      if (skipPermissions) {
        args.push("--allow-all");
      } else {
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

    const type = typeof obj.type === "string" ? obj.type : "";
    const normalized = type.toLowerCase().replace(/-/g, "_");
    const data = objectValue(obj.data);
    // Copilot wraps the meaningful fields under `data` on some event shapes and at
    // the top level on others; prefer the nested payload when present.
    const payload = Object.keys(data).length > 0 ? data : obj;
    const item = obj.item as Record<string, unknown> | undefined;
    const tokens = extractCopilotTokens(payload);

    const result: ParsedStreamEvent = {};

    const sessionId = extractCopilotSessionId(obj, normalized, payload);
    if (sessionId) result.providerSessionId = sessionId;

    const liveStats = buildCopilotLiveStats(tokens);
    if (liveStats) result.liveStats = liveStats;

    const stats = buildCopilotStats(obj, type, payload, tokens);
    if (stats) {
      result.stats = stats;
      result.turnComplete = true;
    }

    const toolActivity = extractCopilotToolActivity(obj, type, payload, item);
    if (toolActivity) result.toolActivity = toolActivity;

    const toolResult = extractCopilotToolResult(obj, type, payload, item);
    if (toolResult) result.toolResult = toolResult;

    const assistantText = extractCopilotAssistantText(obj);
    if (assistantText) result.assistantText = assistantText;

    return isEmptyParsedEvent(result) ? undefined : result;
  }
}
