import type { ParseContext, ParsedStreamEvent } from "./types.js";
import { COPILOT_RESULT_TYPES, COPILOT_SESSION_START_TYPES } from "./copilot-event-types.js";
import {
  contentToText,
  getString,
  getStringArray,
  hasFields,
  numberValue,
  objectValue,
  optionalObject,
  parseInput,
  pushDisplay,
  registerToolName,
  stringValue,
  stringifyValue,
  toolNameFor,
} from "./shared.js";

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

function normalizedType(obj: Record<string, unknown>): string {
  return String((obj.type as string) || (obj.event as string) || (obj.name as string) || "").toLowerCase().replace(/-/g, "_");
}

/**
 * Extract assistant text from Copilot's varied message shapes (CLI nested, REST
 * flat, legacy). Single definition (#951) — the offline session-summary parser
 * consumes this via `parseCopilotEvent`, and the server-side fork in
 * agent-provider/helpers.ts was deleted; its field coverage (top-level
 * `text`/`message` on `assistant.message`, bare `content[]` arrays with no
 * recognizable type/role) is unioned in here.
 */
function extractCopilotAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String((obj.role as string) || "").toLowerCase();
  const data = objectValue(obj.data);
  const message = objectValue(obj.message);
  if (type === "assistant.message") {
    return contentToText(data.content)
      || getString(data, ["content", "text", "message"])
      || getString(obj, ["text", "message"]);
  }
  if (type === "assistant" || type === "assistant_message" || role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message", "delta"]) || contentToText(message.content) || getString(message, ["text", "content", "message"]);
  }
  if (type === "message" && role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message"]);
  }
  // Legacy flexible shapes: a bare top-level content[] with no recognizable
  // type/role. Never applied to user/system/session/tool events.
  if (!role && !type.includes("user") && !type.includes("system") && !type.includes("session") && !type.includes("tool")) {
    return contentToText(obj.content);
  }
  return "";
}

function formatShutdownResult(shutdownType: string, linesAdded: number, linesRemoved: number, filesModified: string[]): string {
  return filesModified.length > 0
    ? `${shutdownType ? `${shutdownType} - ` : ""}+${linesAdded}/-${linesRemoved} lines in ${filesModified.length} file${filesModified.length !== 1 ? "s" : ""}`
    : shutdownType;
}

export function parseCopilotEvent(obj: Record<string, unknown>, rawLine: string, context: ParseContext): ParsedStreamEvent | undefined {
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
    const input = parseInput(payload.input ?? payload.arguments ?? item.input);
    result.toolActivity = { name: toolName, input, toolUseId: id };
    registerToolName(context, id, toolName);
    // A completion event that happens to carry the tool name (e.g. tool_call.completed)
    // must not be counted as a second invocation — it is handled as a tool result below.
    const isResultish = type.includes("complete") || type.includes("end") || type.includes("result");
    if ((type.includes("start") || type.includes("call") || type.includes("use")) && !isResultish) {
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
