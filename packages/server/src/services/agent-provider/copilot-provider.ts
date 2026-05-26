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

export class CopilotProvider implements AgentProvider {
  readonly name = "copilot";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

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
      const loader = resolveCopilotNpmLoader(command, this.fs);
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
        success: payload.is_error !== true && payload.error === undefined && numberValue(payload.exitCode) === 0,
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
