export type AgentStreamProvider = "claude" | "codex" | "copilot" | "pi";

export interface AgentDisplayInitEvent {
  kind: "init";
  model: string;
  sessionId: string;
  cwd: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
}

export interface AgentDisplayAssistantEvent {
  kind: "assistant";
  text: string;
  model: string;
}

export interface AgentDisplayThinkingEvent {
  kind: "thinking";
  text: string;
}

export interface AgentDisplayResultEvent {
  kind: "result";
  success: boolean;
  durationMs: number;
  result: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AgentDisplayToolUseEvent {
  kind: "tool_use";
  id: string;
  name: string;
  input: string;
  inputParsed: Record<string, unknown>;
}

export interface AgentDisplayToolResultEvent {
  kind: "tool_result";
  toolName: string;
  toolUseId: string;
  output: string;
  isError: boolean;
  images?: { mediaType: string; data: string }[];
}

export interface AgentDisplayImageEvent {
  kind: "image";
  mediaType: string;
  data: string;
}

export interface AgentDisplayTaskStartedEvent {
  kind: "task_started";
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: string;
}

export interface AgentDisplayNotificationEvent {
  kind: "notification";
  key: string;
  text: string;
  priority: string;
}

export interface AgentDisplayRateLimitEvent {
  kind: "rate_limit";
  status: string;
  resetsAt: number;
  rateLimitType: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export interface AgentDisplayRawEvent {
  kind: "raw";
  text: string;
}

export type AgentDisplayEvent =
  | AgentDisplayInitEvent
  | AgentDisplayAssistantEvent
  | AgentDisplayThinkingEvent
  | AgentDisplayResultEvent
  | AgentDisplayToolUseEvent
  | AgentDisplayToolResultEvent
  | AgentDisplayImageEvent
  | AgentDisplayTaskStartedEvent
  | AgentDisplayNotificationEvent
  | AgentDisplayRateLimitEvent
  | AgentDisplayRawEvent;

export interface ParsedStreamEvent {
  providerSessionId?: string;
  exitPlanModeDenied?: boolean;
  stats?: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    contextTokens?: number;
    numTurns: number;
    model: string;
    success: boolean;
    agentSummary?: string;
  };
  turnComplete?: boolean;
  liveStats?: {
    model: string;
    contextTokens: number;
    toolUses?: number;
    subagentDelta?: number;
  };
  toolActivity?: {
    name: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  };
  toolResult?: {
    toolUseId: string;
    images?: Array<{ mediaType: string; data: string }>;
    agentResultText?: string;
  };
  assistantText?: string;
  todos?: Array<{ subject: string; status: string }>;
  rateLimitInfo?: {
    status: string;
    rateLimitType: string;
    resetsAt?: number;
    retryAfter?: string;
    message?: string;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
  displayEvents?: AgentDisplayEvent[];
}

interface ParseContext {
  toolNames?: Map<string, string>;
  model?: string;
  lastErrorSignature?: string;
}

export function createAgentStreamParseContext(): ParseContext {
  return { toolNames: new Map<string, string>() };
}

export function parseAgentStreamLine(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  switch (provider) {
    case "claude":
      return parseClaudeEvent(obj, context);
    case "codex":
      return parseCodexEvent(obj, context);
    case "copilot":
      return parseCopilotEvent(obj, line, context);
    case "pi":
      return parsePiEvent(obj, context);
  }
}

export function parseAgentProviderStreamLine(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  const parsed = parseAgentStreamLine(provider, line, context);
  if (!parsed) return undefined;
  const providerEvent = { ...parsed };
  delete providerEvent.displayEvents;
  return hasProviderFields(providerEvent) ? providerEvent : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = objectValue(block);
      return stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.message) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function getString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pushDisplay(result: ParsedStreamEvent, event: AgentDisplayEvent): void {
  (result.displayEvents ??= []).push(event);
}

function hasFields(result: ParsedStreamEvent): boolean {
  return hasProviderFields(result) ||
    (result.displayEvents?.length ?? 0) > 0;
}

function hasProviderFields(result: ParsedStreamEvent): boolean {
  return result.providerSessionId !== undefined ||
    result.exitPlanModeDenied !== undefined ||
    result.stats !== undefined ||
    result.turnComplete !== undefined ||
    result.liveStats !== undefined ||
    result.toolActivity !== undefined ||
    result.toolResult !== undefined ||
    result.assistantText !== undefined ||
    result.todos !== undefined ||
    result.rateLimitInfo !== undefined;
}

function parseInput(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (Object.keys(record).length > 0) return record;
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

function registerToolName(context: ParseContext, id: string | undefined, name: string): void {
  if (!id) return;
  (context.toolNames ??= new Map<string, string>()).set(id, name);
}

function toolNameFor(context: ParseContext, id: string | undefined, fallback: string): string {
  return id ? context.toolNames?.get(id) ?? fallback : fallback;
}

function parseClaudeEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = obj.type;
  const subtype = obj.subtype;
  const isSubagentMessage = obj.parent_tool_use_id != null;

  if (type === "system" && subtype === "init") {
    const sessionId = stringValue(obj.session_id) ?? "";
    if (sessionId) result.providerSessionId = sessionId;
    pushDisplay(result, {
      kind: "init",
      model: stringValue(obj.model) ?? "unknown",
      sessionId,
      cwd: stringValue(obj.cwd) ?? "",
      tools: getStringArray(obj.tools),
      mcpServers: Array.isArray(obj.mcp_servers) ? obj.mcp_servers as { name: string; status: string }[] : [],
      permissionMode: stringValue(obj.permissionMode) ?? "",
    });
  } else if (type === "system" && subtype === "task_started") {
    pushDisplay(result, {
      kind: "task_started",
      taskId: stringValue(obj.task_id) ?? "",
      toolUseId: stringValue(obj.tool_use_id) ?? "",
      description: stringValue(obj.description) ?? "",
      taskType: stringValue(obj.task_type) ?? "",
    });
  } else if (type === "system" && subtype === "notification") {
    pushDisplay(result, {
      kind: "notification",
      key: stringValue(obj.key) ?? "",
      text: stringValue(obj.text) ?? "",
      priority: stringValue(obj.priority) ?? "",
    });
  } else if (type === "system" && subtype === "status") {
    const text = stringValue(obj.status) ?? stringValue(obj.message);
    if (text) pushDisplay(result, { kind: "raw", text: `[status] ${text}` });
  } else if (type === "system" && subtype === "task_progress") {
    const usage = objectValue(obj.usage);
    const toolUses = numberValue(usage.tool_uses);
    if (toolUses) result.liveStats = { model: "", contextTokens: 0, toolUses };
    const text = stringValue(obj.message) ?? stringValue(obj.progress);
    if (text) pushDisplay(result, { kind: "raw", text: `[progress] ${text}` });
  }

  if (type === "assistant") {
    const message = objectValue(obj.message);
    const usage = objectValue(message.usage);
    const model = stringValue(message.model) ?? "";
    const contextTokens = numberValue(usage.cache_read_input_tokens) + numberValue(usage.input_tokens);
    if (!isSubagentMessage && (model || contextTokens > 0)) {
      result.liveStats = { model, contextTokens };
    }

    const content = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
    const textParts: string[] = [];
    for (const block of content) {
      const blockType = block.type;
      if (blockType === "thinking") {
        const text = stringValue(block.thinking);
        if (text) pushDisplay(result, { kind: "thinking", text });
      } else if (blockType === "text") {
        const text = stringValue(block.text);
        if (text) {
          textParts.push(text);
          pushDisplay(result, { kind: "assistant", text, model });
        }
      } else if (blockType === "image") {
        const source = objectValue(block.source);
        if (source.type === "base64" && typeof source.data === "string") {
          pushDisplay(result, { kind: "image", mediaType: stringValue(source.media_type) ?? "image/png", data: source.data });
        }
      } else if (blockType === "tool_use") {
        const id = stringValue(block.id) ?? "";
        const name = stringValue(block.name) ?? "unknown";
        const input = objectValue(block.input);
        registerToolName(context, id, name);
        if (!result.toolActivity) result.toolActivity = { name, input, toolUseId: id || undefined };
        pushDisplay(result, { kind: "tool_use", id, name, input: JSON.stringify(block.input, null, 2), inputParsed: input });
        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          result.todos = (input.todos as Array<{ subject: string; status: string }>).map((t) => ({ subject: t.subject, status: t.status }));
        }
        if (name === "Agent") {
          result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens: 0 }), subagentDelta: 1 };
        }
      }
    }
    if (textParts.length > 0) result.assistantText = textParts.join("\n");
  }

  if (type === "user") {
    const content = Array.isArray(objectValue(obj.message).content)
      ? objectValue(obj.message).content as Record<string, unknown>[]
      : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const toolUseId = stringValue(block.tool_use_id) ?? "";
      const images: Array<{ mediaType: string; data: string }> = [];
      let output = "";
      if (typeof block.content === "string") {
        output = block.content;
      } else if (Array.isArray(block.content)) {
        const textParts: string[] = [];
        for (const inner of block.content as Record<string, unknown>[]) {
          if (inner.type === "text" && typeof inner.text === "string") textParts.push(inner.text);
          const source = objectValue(inner.source);
          if (inner.type === "image" && source.type === "base64" && typeof source.data === "string") {
            images.push({ mediaType: stringValue(source.media_type) ?? "image/png", data: source.data });
          }
        }
        output = textParts.length > 0 ? textParts.join("\n") : images.length > 0 ? "" : JSON.stringify(block.content);
      } else {
        output = JSON.stringify(block.content);
      }
      result.toolResult = {
        toolUseId,
        ...(images.length > 0 ? { images } : {}),
        ...(output ? { agentResultText: output } : {}),
      };
      pushDisplay(result, {
        kind: "tool_result",
        toolName: toolNameFor(context, toolUseId, toolUseId ? `tool_${toolUseId}` : "unknown"),
        toolUseId,
        output,
        isError: block.is_error === true,
        ...(images.length > 0 ? { images } : {}),
      });
    }
  }

  if (type === "rate_limit_event") {
    const info = objectValue(obj.rate_limit_info);
    result.rateLimitInfo = {
      status: stringValue(info.status) ?? "",
      rateLimitType: stringValue(info.rateLimitType) ?? "",
      resetsAt: numberValue(info.resetsAt) || undefined,
      overageStatus: stringValue(info.overageStatus),
      overageDisabledReason: stringValue(info.overageDisabledReason),
      isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
    };
    pushDisplay(result, {
      kind: "rate_limit",
      status: result.rateLimitInfo.status,
      resetsAt: result.rateLimitInfo.resetsAt ?? 0,
      rateLimitType: result.rateLimitInfo.rateLimitType,
      overageStatus: result.rateLimitInfo.overageStatus,
      overageDisabledReason: result.rateLimitInfo.overageDisabledReason,
      isUsingOverage: result.rateLimitInfo.isUsingOverage,
    });
  }

  if (type === "result") {
    const usage = objectValue(obj.usage);
    const modelUsage = objectValue(obj.modelUsage);
    const firstModelEntry = Object.keys(modelUsage).length > 0
      ? Object.entries(modelUsage)[0] as [string, Record<string, unknown>]
      : undefined;
    const firstModelUsage = firstModelEntry?.[1];
    const rawCost = obj.total_cost_usd ?? obj.cost_usd;
    const inputTokens = numberValue(firstModelUsage?.inputTokens ?? usage.input_tokens);
    const outputTokens = numberValue(firstModelUsage?.outputTokens ?? usage.output_tokens);
    const model = firstModelEntry?.[0] ?? stringValue(obj.model) ?? "";
    if (!isSubagentMessage) {
      result.stats = {
        durationMs: numberValue(obj.duration_ms),
        totalCostUsd: numberValue(rawCost),
        inputTokens,
        outputTokens,
        numTurns: numberValue(obj.num_turns) || 1,
        model,
        success: obj.subtype === "success" && !obj.is_error,
        agentSummary: stringValue(obj.result),
      };
      result.turnComplete = true;
      pushDisplay(result, {
        kind: "result",
        success: result.stats.success,
        durationMs: result.stats.durationMs,
        result: result.stats.agentSummary ?? "",
        totalCostUsd: result.stats.totalCostUsd,
        inputTokens,
        outputTokens,
        model,
      });
    }
    const contextTokens = numberValue(usage.cache_read_input_tokens) + numberValue(usage.input_tokens);
    if (!isSubagentMessage && contextTokens > 0) {
      result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens }), contextTokens };
    }
    const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials as Array<Record<string, unknown>> : [];
    if (denials.some((d) => d.tool_name === "ExitPlanMode")) result.exitPlanModeDenied = true;
  }

  return hasFields(result) ? result : undefined;
}

const CODEX_USAGE_LIMIT_PATTERN = /you(?:['\u2019])?ve hit your usage limit for\s+(.+?)(?:\.|$)/i;
const CODEX_RETRY_AFTER_PATTERN = /try again at\s+(.+?)(?:\.|$)/i;

function detectCodexUsageLimitText(text: string | undefined): { message: string; retryAfter?: string } | undefined {
  if (!text || !CODEX_USAGE_LIMIT_PATTERN.test(text)) return undefined;
  return { message: text.trim(), retryAfter: CODEX_RETRY_AFTER_PATTERN.exec(text)?.[1]?.trim() };
}

function parseCodexEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = obj.type;
  if (type === "thread.started") {
    const sessionId = stringValue(obj.thread_id);
    if (sessionId) {
      result.providerSessionId = sessionId;
      pushDisplay(result, { kind: "init", model: "codex", sessionId, cwd: "", tools: [], mcpServers: [], permissionMode: "" });
    }
  }

  const error = objectValue(obj.error);
  const usageLimit = detectCodexUsageLimitText(stringValue(obj.message) ?? stringValue(error.message));
  if (usageLimit) {
    result.rateLimitInfo = {
      status: "limited",
      rateLimitType: "usage_limit",
      retryAfter: usageLimit.retryAfter,
      message: usageLimit.message,
    };
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = objectValue(obj.item);
    const itemType = item.type;
    const id = stringValue(item.id) ?? "";
    if (itemType === "agent_message") {
      const text = stringValue(item.text);
      if (text) {
        result.assistantText = text;
        pushDisplay(result, { kind: "assistant", text, model: "codex" });
      }
    } else if (itemType === "reasoning") {
      const text = stringValue(item.text);
      if (text) pushDisplay(result, { kind: "thinking", text });
    } else if (itemType === "command_execution") {
      const command = stringValue(item.command) ?? "";
      if ((type === "item.started" || item.status === "in_progress") && command) {
        result.toolActivity = { name: "shell", input: { command }, toolUseId: id || undefined };
        registerToolName(context, id, "shell_command");
        pushDisplay(result, { kind: "tool_use", id, name: "shell_command", input: command, inputParsed: { command } });
      }
      if (type === "item.completed" || item.status === "completed") {
        const output = stringValue(item.aggregated_output) ?? "";
        result.toolResult = { toolUseId: id };
        if (output) {
          pushDisplay(result, {
            kind: "tool_result",
            toolName: "shell_command",
            toolUseId: id,
            output,
            isError: item.exit_code !== null && item.exit_code !== 0,
          });
        }
      }
    } else if (itemType === "mcp_tool_call") {
      const name = stringValue(item.name) ?? "mcp_tool";
      const args = objectValue(item.args);
      if ((type === "item.started" || item.status === "in_progress")) {
        result.toolActivity = { name, input: args, toolUseId: id || undefined };
        registerToolName(context, id, name);
        pushDisplay(result, { kind: "tool_use", id, name, input: JSON.stringify(args, null, 2), inputParsed: args });
      }
      if (type === "item.completed" || item.status === "completed") {
        const resultText = stringValue(item.result);
        result.toolResult = { toolUseId: id, ...(resultText ? { agentResultText: resultText } : {}) };
        if (resultText) {
          pushDisplay(result, { kind: "tool_result", toolName: name, toolUseId: id, output: resultText, isError: false });
        }
      }
    } else if (itemType === "file_change") {
      const path = stringValue(item.path) ?? "";
      pushDisplay(result, { kind: "tool_use", id, name: "file_change", input: path, inputParsed: { path } });
    }
  }

  if (type === "turn.completed") {
    const usage = objectValue(obj.usage);
    const totalUsage = optionalObject(usage.total_token_usage) ?? usage;
    const currentUsage = optionalObject(usage.last_token_usage) ?? optionalObject(obj.last_token_usage) ?? usage;
    const inputTokens = numberValue(totalUsage.input_tokens);
    const outputTokens = numberValue(totalUsage.output_tokens);
    const contextTokens = numberValue(currentUsage.input_tokens) || inputTokens;
    result.stats = {
      durationMs: 0,
      totalCostUsd: 0,
      inputTokens,
      outputTokens,
      contextTokens,
      numTurns: 1,
      model: "codex",
      success: true,
    };
    result.liveStats = { model: "", contextTokens };
    result.turnComplete = true;
    pushDisplay(result, {
      kind: "result",
      success: true,
      durationMs: 0,
      result: "",
      totalCostUsd: 0,
      inputTokens,
      outputTokens,
      model: "codex",
    });
  } else if (type === "turn.failed") {
    const message = stringValue(error.message) ?? "Turn failed";
    pushDisplay(result, {
      kind: "result",
      success: false,
      durationMs: 0,
      result: message,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: "codex",
    });
  } else if (type === "error") {
    pushDisplay(result, { kind: "raw", text: stringValue(obj.message) ?? "Error" });
  }

  return hasFields(result) ? result : undefined;
}

const COPILOT_SESSION_START_TYPES = new Set(["session_start", "session_started", "session_created", "session.start", "session.started", "session.created"]);
const COPILOT_IGNORED_TYPES = new Set([
  "assistant.message_start",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.turn_start",
  "assistant.turn_end",
  "session.background_tasks_changed",
  "session.mcp_servers_loaded",
  "session.model_change",
  "session.skills_loaded",
  "session.warning",
  "session.tools_updated",
]);
const COPILOT_RESULT_TYPES = new Set(["result", "done", "session_end", "session_ended", "session.end", "session.ended", "turn_completed", "turn.completed", "stats"]);

function normalizedType(obj: Record<string, unknown>): string {
  return String((obj.type as string) || (obj.event as string) || (obj.name as string) || "").toLowerCase().replace(/-/g, "_");
}

function extractCopilotAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String((obj.role as string) || "").toLowerCase();
  const data = objectValue(obj.data);
  const message = objectValue(obj.message);
  if (type === "assistant.message" && Object.keys(data).length > 0) {
    return contentToText(data.content) || getString(data, ["content", "text", "message"]);
  }
  if (type === "assistant" || type === "assistant_message" || role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message", "delta"]) || contentToText(message.content) || getString(message, ["text", "content", "message"]);
  }
  if (type === "message" && role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message"]);
  }
  return "";
}

function formatShutdownResult(shutdownType: string, linesAdded: number, linesRemoved: number, filesModified: string[]): string {
  return filesModified.length > 0
    ? `${shutdownType ? `${shutdownType} - ` : ""}+${linesAdded}/-${linesRemoved} lines in ${filesModified.length} file${filesModified.length !== 1 ? "s" : ""}`
    : shutdownType;
}

function parseCopilotEvent(obj: Record<string, unknown>, rawLine: string, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = normalizedType(obj);
  const data = optionalObject(obj.data);
  const payload = data ?? obj;
  const item = objectValue(obj.item);
  const usage = objectValue(payload.usage ?? payload.stats);
  const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
  const cachedTokens = numberValue(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens);
  const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
  const model = stringValue(payload.model) ?? stringValue(objectValue(payload.provider).model) ?? "";

  const sessionId = stringValue(payload.session_id) ??
    stringValue(payload.sessionId) ??
    stringValue(objectValue(payload.session).id) ??
    (COPILOT_SESSION_START_TYPES.has(type) ? stringValue(obj.id) : undefined);
  if (sessionId) result.providerSessionId = sessionId;

  if (inputTokens || cachedTokens || model) {
    result.liveStats = { model, contextTokens: inputTokens + cachedTokens };
  }

  if (COPILOT_SESSION_START_TYPES.has(type)) {
    const contextRecord = objectValue(payload.context);
    const cwd = getString(payload, ["cwd", "working_directory", "workingDirectory"]) || getString(contextRecord, ["cwd", "working_directory", "workingDirectory"]);
    const initModel = getString(payload, ["model", "modelId", "model_id"]) || getString(contextRecord, ["model", "modelId", "model_id"]) || context.model || "copilot";
    pushDisplay(result, {
      kind: "init",
      model: initModel,
      sessionId: getString(payload, ["session_id", "sessionId", "sessionID", "id"]) || getString(obj, ["id"]),
      cwd,
      tools: getStringArray(payload.tools),
      mcpServers: [],
      permissionMode: getString(payload, ["permissionMode", "permission_mode"]),
    });
  } else if (type === "session.model_change" && data) {
    const newModel = getString(data, ["newModel", "model", "modelId", "model_id"]);
    if (newModel) context.model = newModel;
  } else if (type === "session.shutdown" && data) {
    const codeChanges = objectValue(data.codeChanges);
    const filesModified = Array.isArray(codeChanges.filesModified)
      ? (codeChanges.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const shutdownType = stringValue(data.shutdownType) ?? "";
    pushDisplay(result, {
      kind: "result",
      success: shutdownType !== "error" && shutdownType !== "abrupt",
      durationMs: numberValue(data.totalApiDurationMs),
      result: formatShutdownResult(shutdownType, Number(codeChanges.linesAdded ?? 0), Number(codeChanges.linesRemoved ?? 0), filesModified),
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: context.model ?? "",
    });
  } else if (type === "user.message" && data) {
    const content = getString(data, ["content"]);
    if (content) {
      const firstLine = content.split("\n")[0].trim();
      pushDisplay(result, {
        kind: "notification",
        key: "user",
        text: firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine,
        priority: "user",
      });
    }
  } else if (type === "assistant.reasoning") {
    const text = data ? getString(data, ["content", "text"]) : "";
    if (text) pushDisplay(result, { kind: "thinking", text });
  } else if (type === "assistant.message" && data) {
    const msgModel = getString(data, ["model", "modelId", "model_id"]);
    if (msgModel) context.model = msgModel;
    const reasoningText = getString(data, ["reasoningText", "reasoning_text"]);
    if (reasoningText) pushDisplay(result, { kind: "thinking", text: reasoningText });
    const contentText = contentToText(data.content) || getString(data, ["content", "text", "message"]);
    if (contentText) {
      result.assistantText = contentText;
      pushDisplay(result, { kind: "assistant", text: contentText, model: msgModel || context.model || "" });
    }
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const request of toolRequests) {
      const requestRecord = objectValue(request);
      registerToolName(context, getString(requestRecord, ["toolCallId", "id", "call_id"]), getString(requestRecord, ["name"]));
    }
  } else if (type === "subagent.started" && data) {
    pushDisplay(result, {
      kind: "task_started",
      taskId: getString(obj, ["agentId"]) || getString(data, ["agentName"]) || getString(data, ["toolCallId"]),
      toolUseId: getString(data, ["toolCallId"]),
      description: getString(data, ["agentDisplayName", "agentDescription", "agentName"]),
      taskType: getString(data, ["agentName"]),
    });
  } else if (type === "subagent.completed" && data) {
    const toolUseId = getString(data, ["toolCallId"]);
    pushDisplay(result, {
      kind: "tool_result",
      toolName: toolNameFor(context, toolUseId, "Agent"),
      toolUseId,
      output: `${getString(data, ["agentDisplayName", "agentName"]) || "Subagent"} completed`,
      isError: false,
    });
  } else if (type === "system.notification" && data) {
    const kind = objectValue(data.kind);
    pushDisplay(result, {
      kind: "notification",
      key: getString(kind, ["type", "agentId"]) || "notification",
      text: getString(data, ["content"]).replace(/<\/?system_notification>/g, "").trim(),
      priority: "",
    });
  }

  const toolName = stringValue(payload.name ?? payload.tool_name ?? payload.toolName ?? item.tool_name ?? item.toolName ?? item.name);
  if (type === "tool.execution_start") {
    const id = stringValue(payload.toolCallId);
    const name = stringValue(payload.toolName) ?? "copilot_tool";
    const inputValue = payload.arguments;
    const inputParsed = parseInput(inputValue);
    result.toolActivity = { name, input: inputParsed, toolUseId: id };
    registerToolName(context, id, name);
    pushDisplay(result, { kind: "tool_use", id: id ?? "", name, input: stringifyValue(inputValue), inputParsed });
  } else if (toolName) {
    const id = stringValue(payload.id ?? payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? item.id);
    const input = objectValue(payload.input ?? payload.arguments ?? item.input);
    result.toolActivity = { name: toolName, input, toolUseId: id };
    registerToolName(context, id, toolName);
    if (type.includes("start") || type.includes("call") || type.includes("use")) {
      pushDisplay(result, { kind: "tool_use", id: id ?? "", name: toolName, input: stringifyValue(payload.input ?? payload.arguments ?? item.input), inputParsed: input });
    }
  } else if (type.includes("command") || item.type === "command_execution") {
    const command = stringValue(obj.command ?? item.command);
    if (command) {
      const id = stringValue(obj.id ?? item.id);
      result.toolActivity = { name: "shell", input: { command }, toolUseId: id };
    }
  }

  if (type.includes("tool") && (type.includes("complete") || type.includes("completed") || type.includes("end") || type.includes("result"))) {
    const id = stringValue(payload.id ?? payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? obj.id ?? item.id);
    if (id) {
      const resultRecord = objectValue(payload.result);
      const output = stringifyValue(resultRecord.content ?? resultRecord.detailedContent ?? payload.output ?? payload.result ?? payload.content ?? payload.message ?? payload.error);
      const name = stringValue(payload.name ?? payload.tool ?? payload.tool_name ?? payload.toolName ?? payload.kind) ?? toolNameFor(context, id, "copilot_tool");
      result.toolResult = { toolUseId: id, ...(output ? { agentResultText: output } : {}) };
      pushDisplay(result, {
        kind: "tool_result",
        toolName: name,
        toolUseId: id,
        output,
        isError: payload.success === false || Boolean(payload.is_error || payload.isError || payload.error) || String(payload.status ?? "").toLowerCase() === "error" || String(payload.status ?? "").toLowerCase() === "failed",
      });
    }
  } else if (item.type === "command_execution" && item.id && type.includes("completed")) {
    result.toolResult = { toolUseId: String(item.id as string | number) };
  }

  const assistantText = extractCopilotAssistantText(obj);
  if (assistantText && !result.displayEvents?.some((event) => event.kind === "assistant" && event.text === assistantText)) {
    const msgModel = getString(data ?? obj, ["model", "modelId", "model_id"]);
    if (msgModel) context.model = msgModel;
    result.assistantText = assistantText;
    pushDisplay(result, { kind: "assistant", text: assistantText, model: msgModel || context.model || "" });
  }

  if (COPILOT_RESULT_TYPES.has(type)) {
    const status = String((payload.status as string) || (payload.subtype as string) || "").toLowerCase();
    const stats = {
      durationMs: numberValue(payload.duration_ms ?? payload.durationMs ?? usage.sessionDurationMs ?? usage.duration_ms ?? usage.durationMs),
      totalCostUsd: numberValue(payload.total_cost_usd ?? payload.cost_usd ?? payload.costUsd),
      inputTokens,
      outputTokens,
      numTurns: numberValue(obj.num_turns ?? obj.numTurns) || 1,
      model,
      success: Number(payload.exitCode ?? 0) === 0 && !(payload.is_error || payload.isError || payload.error) && status !== "error" && status !== "failed",
      agentSummary: getString(payload, ["result", "message", "summary"]) || stringifyValue(payload.error),
    };
    result.stats = stats;
    result.turnComplete = true;
    pushDisplay(result, {
      kind: "result",
      success: stats.success,
      durationMs: stats.durationMs,
      result: stats.agentSummary ?? "",
      totalCostUsd: stats.totalCostUsd,
      inputTokens,
      outputTokens,
      model,
    });
  }

  if (!hasFields(result) && !COPILOT_IGNORED_TYPES.has(type)) {
    const rawText = getString(obj, ["message", "text", "content", "status"]);
    pushDisplay(result, { kind: "raw", text: rawText || rawLine });
  }

  return hasFields(result) ? result : undefined;
}

function extractPiUsage(message: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  totalCostUsd: number;
} {
  const usage = objectValue(message.usage);
  const cost = objectValue(usage.cost);
  const inputTokens = numberValue(usage.input);
  const outputTokens = numberValue(usage.output);
  return {
    inputTokens,
    outputTokens,
    contextTokens: inputTokens + numberValue(usage.cacheRead),
    totalCostUsd: numberValue(cost.total),
  };
}

function extractPiContentText(content: unknown): string | undefined {
  const text = contentToText(content);
  return text || undefined;
}

function parsePiEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = stringValue(obj.type);
  const message = objectValue(obj.message);
  const assistantEvent = objectValue(obj.assistantMessageEvent);

  if (type === "session") {
    const sessionId = stringValue(obj.id) ?? "";
    if (sessionId) result.providerSessionId = sessionId;
    pushDisplay(result, {
      kind: "init",
      model: context.model ?? "pi",
      sessionId,
      cwd: stringValue(obj.cwd) ?? "",
      tools: [],
      mcpServers: [],
      permissionMode: "",
    });
  }

  if (type === "message_update") {
    const eventType = assistantEvent.type;
    const msgModel = stringValue(message.model);
    if (msgModel) context.model = msgModel;
    if (eventType === "text_delta" && typeof assistantEvent.delta === "string") {
      result.assistantText = assistantEvent.delta;
      pushDisplay(result, { kind: "assistant", text: assistantEvent.delta, model: msgModel || context.model || "pi" });
    } else if (eventType === "text_start" || eventType === "text_end") {
      const text = stringValue(assistantEvent.content);
      if (text) result.assistantText = text;
    } else if (eventType === "toolcall_start" || eventType === "toolcall_end") {
      let toolCall = objectValue(assistantEvent.toolCall);
      if (Object.keys(toolCall).length === 0) {
        const partialContent = objectValue(assistantEvent.partial).content;
        if (Array.isArray(partialContent)) toolCall = objectValue(partialContent[0]);
      }
      const name = stringValue(toolCall.name);
      if (name) result.toolActivity = { name, input: objectValue(toolCall.arguments), toolUseId: stringValue(toolCall.id) };
    }
  }

  if (type === "tool_execution_start") {
    const id = stringValue(obj.toolCallId) ?? "";
    const name = stringValue(obj.toolName) ?? "pi_tool";
    const input = objectValue(obj.args);
    result.toolActivity = { name, input, toolUseId: id || undefined };
    registerToolName(context, id, name);
    pushDisplay(result, { kind: "tool_use", id, name, input: stringifyValue(obj.args), inputParsed: input });
  }

  if (type === "tool_execution_end") {
    const id = stringValue(obj.toolCallId) ?? "";
    const output = extractPiContentText(objectValue(obj.result).content) ?? stringifyValue(obj.result);
    result.toolResult = { toolUseId: id, ...(output ? { agentResultText: output } : {}) };
    pushDisplay(result, {
      kind: "tool_result",
      toolName: stringValue(obj.toolName) ?? toolNameFor(context, id, "pi_tool"),
      toolUseId: id,
      output,
      isError: obj.isError === true,
    });
  }

  if (type === "message_start" || type === "message_end") {
    if (message.model) context.model = stringValue(message.model);
    if (message.role === "toolResult") {
      const id = stringValue(message.toolCallId);
      if (id) result.toolResult = { toolUseId: id, ...(extractPiContentText(message.content) ? { agentResultText: extractPiContentText(message.content) } : {}) };
    } else if (message.role === "assistant") {
      const text = extractPiContentText(message.content);
      if (text) result.assistantText = text;
    }
    if (message.stopReason === "error") {
      const errorMessage = stringValue(message.errorMessage) ?? "Pi turn failed";
      const signature = `${stringValue(message.model) || context.model || "pi"}:${errorMessage}`;
      if (signature !== context.lastErrorSignature) {
        context.lastErrorSignature = signature;
        const usage = extractPiUsage(message);
        pushDisplay(result, {
          kind: "result",
          success: false,
          durationMs: 0,
          result: errorMessage,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: stringValue(message.model) || context.model || "pi",
        });
      }
    }
  }

  if ((type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end") && Object.keys(message).length > 0) {
    const usage = extractPiUsage(message);
    const model = stringValue(message.model) ?? "";
    if (model || usage.contextTokens > 0) result.liveStats = { model, contextTokens: usage.contextTokens };
  }

  if (type === "turn_end") {
    const usageMessage = Object.keys(message).length > 0 ? message : objectValue(obj.message);
    const usage = extractPiUsage(usageMessage);
    result.stats = {
      durationMs: 0,
      totalCostUsd: usage.totalCostUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      contextTokens: usage.contextTokens,
      numTurns: 1,
      model: stringValue(usageMessage.model) ?? "",
      success: usageMessage.stopReason !== "error",
      agentSummary: extractPiContentText(usageMessage.content),
    };
    result.turnComplete = true;
    if (usageMessage.stopReason === "error") {
      const errorMessage = stringValue(usageMessage.errorMessage);
      if (errorMessage && /rate.?limit|usage.?limit|quota/i.test(errorMessage)) {
        result.rateLimitInfo = { status: "limited", rateLimitType: "usage_limit", message: errorMessage };
      }
    }
  }

  if (type === "agent_end") {
    const messages = Array.isArray(obj.messages) ? obj.messages : [];
    const lastAssistant = [...messages].reverse()
      .map((entry) => objectValue(entry))
      .find((entry) => entry.role === "assistant");
    if (lastAssistant) {
      if (lastAssistant.model) context.model = stringValue(lastAssistant.model);
      const resultText = lastAssistant.stopReason === "error" ? stringValue(lastAssistant.errorMessage) ?? "Pi turn failed" : "";
      const signature = `${stringValue(lastAssistant.model) || context.model || "pi"}:${resultText}`;
      if (lastAssistant.stopReason !== "error" || signature !== context.lastErrorSignature) {
        if (lastAssistant.stopReason === "error") context.lastErrorSignature = signature;
        const usage = extractPiUsage(lastAssistant);
        pushDisplay(result, {
          kind: "result",
          success: lastAssistant.stopReason !== "error",
          durationMs: 0,
          result: resultText,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: stringValue(lastAssistant.model) || context.model || "pi",
        });
      }
    }
  }

  if (type === "rate_limit_event" || type === "rate_limit") {
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

  if (type === "error") {
    pushDisplay(result, { kind: "raw", text: stringValue(obj.message) ?? JSON.stringify(obj) });
  }

  return hasFields(result) ? result : undefined;
}
