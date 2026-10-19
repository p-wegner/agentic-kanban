import type { ParseContext, ParsedStreamEvent } from "./types.js";
import {
  COPILOT_RESULT_TYPES,
  COPILOT_SESSION_START_TYPES,
  COPILOT_TOOL_RESULT_TYPES,
  COPILOT_TOOL_USE_TYPES,
} from "./copilot-event-types.js";
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
import { recordUnknownFieldDrift } from "./unknown-fields.js";
import { copilotResultPayloadSchema, hasCopilotSuccessSignalFields } from "./copilot-schema.js";

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

// Catch-all raw fallback events (#968): the fallback keeps UI continuity for
// unmatched-but-valid JSON, but it must NOT count as "recognized" in the drift
// detector — before #968 it made literally any JSON parse as defined, so a
// Copilot CLI wire-format change produced ZERO unknown-event counts. Marked via
// a WeakSet (not a ParsedStreamEvent field) so the wire contract is unchanged.
const unmatchedFallbackEvents = new WeakSet<ParsedStreamEvent>();

/** True when the event is only the copilot catch-all raw fallback for an unmatched type (#968). */
export function isCopilotUnmatchedFallback(event: ParsedStreamEvent): boolean {
  return unmatchedFallbackEvents.has(event);
}

/**
 * Tool-shaped type gate (#968): the tool branches used to fire on bare
 * `type.includes("tool")`, so foreign shapes (e.g. `subagent_toolkit.updated`)
 * silently misparsed as tool activity. All known copilot tool type names either
 * live in the shared sets or start with `tool` — require that.
 */
/** A copilot `status` field that means the tool call failed. */
function isErrorStatus(status: string | undefined): boolean {
  const s = status?.toLowerCase();
  return s === "error" || s === "failed";
}

function isCopilotToolishType(type: string): boolean {
  return COPILOT_TOOL_USE_TYPES.has(type) || COPILOT_TOOL_RESULT_TYPES.has(type) || type.startsWith("tool");
}

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

interface CopilotCtx {
  obj: Record<string, unknown>;
  type: string;
  data: Record<string, unknown> | undefined;
  payload: Record<string, unknown>;
  item: Record<string, unknown>;
  usage: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  model: string;
  result: ParsedStreamEvent;
  context: ParseContext;
}

function applySessionStart(c: CopilotCtx): void {
  const { obj, payload, result, context } = c;
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
}

function applyShutdown(data: Record<string, unknown>, result: ParsedStreamEvent, context: ParseContext): void {
  const codeChanges = objectValue(data.codeChanges);
  const filesModified = Array.isArray(codeChanges.filesModified)
    ? (codeChanges.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const shutdownType = stringValue(data.shutdownType) ?? "";
  // #994: success used to be inferred purely from the ABSENCE of "error"/
  // "abrupt" — a renamed or missing shutdownType field silently read as
  // success. Require the field to actually be PRESENT (a genuine positive
  // signal that the CLI reported a shutdown reason) before trusting it;
  // record the drift when it's missing instead of defaulting to success.
  if (!shutdownType) {
    recordUnknownFieldDrift("copilot", "session.shutdown", "shutdownType field missing or empty");
  }
  pushDisplay(result, {
    kind: "result",
    success: Boolean(shutdownType) && shutdownType !== "error" && shutdownType !== "abrupt",
    durationMs: numberValue(data.totalApiDurationMs),
    result: formatShutdownResult(shutdownType, Number(codeChanges.linesAdded ?? 0), Number(codeChanges.linesRemoved ?? 0), filesModified),
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: context.model ?? "",
  });
}

function applyUserMessage(data: Record<string, unknown>, result: ParsedStreamEvent): void {
  const content = getString(data, ["content"]);
  if (!content) return;
  const firstLine = content.split("\n")[0].trim();
  pushDisplay(result, {
    kind: "notification",
    key: "user",
    text: firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine,
    priority: "user",
  });
}

function applyAssistantMessage(data: Record<string, unknown>, result: ParsedStreamEvent, context: ParseContext): void {
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
}

function applySubagentStarted(obj: Record<string, unknown>, data: Record<string, unknown>, result: ParsedStreamEvent): void {
  pushDisplay(result, {
    kind: "task_started",
    taskId: getString(obj, ["agentId"]) || getString(data, ["agentName"]) || getString(data, ["toolCallId"]),
    toolUseId: getString(data, ["toolCallId"]),
    description: getString(data, ["agentDisplayName", "agentDescription", "agentName"]),
    taskType: getString(data, ["agentName"]),
  });
}

function applySubagentCompleted(data: Record<string, unknown>, result: ParsedStreamEvent, context: ParseContext): void {
  const toolUseId = getString(data, ["toolCallId"]);
  pushDisplay(result, {
    kind: "tool_result",
    toolName: toolNameFor(context, toolUseId, "Agent"),
    toolUseId,
    output: `${getString(data, ["agentDisplayName", "agentName"]) || "Subagent"} completed`,
    isError: false,
  });
}

function applySystemNotification(data: Record<string, unknown>, result: ParsedStreamEvent): void {
  const kind = objectValue(data.kind);
  pushDisplay(result, {
    kind: "notification",
    key: getString(kind, ["type", "agentId"]) || "notification",
    text: getString(data, ["content"]).replace(/<\/?system_notification>/g, "").trim(),
    priority: "",
  });
}

/** Message-ish lifecycle events (session start/shutdown, user/assistant/subagent/system messages). */
function applyLifecycleEvent(c: CopilotCtx): void {
  const { type, data, obj, result, context } = c;
  if (COPILOT_SESSION_START_TYPES.has(type)) return applySessionStart(c);
  if (type === "assistant.reasoning") {
    const text = data ? getString(data, ["content", "text"]) : "";
    if (text) pushDisplay(result, { kind: "thinking", text });
    return;
  }
  if (!data) return;
  switch (type) {
    case "session.model_change": {
      const newModel = getString(data, ["newModel", "model", "modelId", "model_id"]);
      if (newModel) context.model = newModel;
      return;
    }
    case "session.shutdown": return applyShutdown(data, result, context);
    case "user.message": return applyUserMessage(data, result);
    case "assistant.message": return applyAssistantMessage(data, result, context);
    case "subagent.started": return applySubagentStarted(obj, data, result);
    case "subagent.completed": return applySubagentCompleted(data, result, context);
    case "system.notification": return applySystemNotification(data, result);
  }
}

function isResultishType(type: string): boolean {
  return type.includes("complete") || type.includes("end") || type.includes("result");
}

function applyToolActivity(c: CopilotCtx): void {
  const { type, obj, payload, item, result, context } = c;
  const toolName = stringValue(payload.name ?? payload.tool_name ?? payload.toolName ?? item.tool_name ?? item.toolName ?? item.name);
  if (type === "tool.execution_start") {
    const id = stringValue(payload.toolCallId);
    const name = stringValue(payload.toolName) ?? "copilot_tool";
    const inputValue = payload.arguments;
    const inputParsed = parseInput(inputValue);
    result.toolActivity = { name, input: inputParsed, toolUseId: id };
    registerToolName(context, id, name);
    pushDisplay(result, { kind: "tool_use", id: id ?? "", name, input: stringifyValue(inputValue), inputParsed });
  } else if (toolName && isCopilotToolishType(type)) {
    const id = stringValue(payload.id ?? payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? item.id);
    const input = parseInput(payload.input ?? payload.arguments ?? item.input);
    result.toolActivity = { name: toolName, input, toolUseId: id };
    registerToolName(context, id, toolName);
    // A completion event that happens to carry the tool name (e.g. tool_call.completed)
    // must not be counted as a second invocation — it is handled as a tool result below.
    if ((type.includes("start") || type.includes("call") || type.includes("use")) && !isResultishType(type)) {
      pushDisplay(result, { kind: "tool_use", id: id ?? "", name: toolName, input: stringifyValue(payload.input ?? payload.arguments ?? item.input), inputParsed: input });
    }
  } else if (type.includes("command") || item.type === "command_execution") {
    const command = stringValue(obj.command ?? item.command);
    if (command) {
      const id = stringValue(obj.id ?? item.id);
      result.toolActivity = { name: "shell", input: { command }, toolUseId: id };
    }
  }
}

function applyToolResult(c: CopilotCtx): void {
  const { type, obj, payload, item, result, context } = c;
  if (COPILOT_TOOL_RESULT_TYPES.has(type) || (isCopilotToolishType(type) && isResultishType(type))) {
    const id = stringValue(payload.id ?? payload.tool_use_id ?? payload.toolUseId ?? payload.toolCallId ?? obj.id ?? item.id);
    if (!id) return;
    const resultRecord = objectValue(payload.result);
    const output = stringifyValue(resultRecord.content ?? resultRecord.detailedContent ?? payload.output ?? payload.result ?? payload.content ?? payload.message ?? payload.error);
    const name = stringValue(payload.name ?? payload.tool ?? payload.tool_name ?? payload.toolName ?? payload.kind) ?? toolNameFor(context, id, "copilot_tool");
    result.toolResult = { toolUseId: id, ...(output ? { agentResultText: output } : {}) };
    pushDisplay(result, {
      kind: "tool_result",
      toolName: name,
      toolUseId: id,
      output,
      // `stringValue`, not `String(...)`: `status` is untyped stream JSON, and
      // `String({...})` yields "[object Object]", which matches neither "error" nor
      // "failed" — so an object-shaped status would render a FAILED tool result as a
      // successful one. Narrowing to an actual string makes the miss explicit.
      isError: payload.success === false
        || Boolean(payload.is_error || payload.isError || payload.error)
        || isErrorStatus(stringValue(payload.status)),
    });
  } else if (item.type === "command_execution" && item.id && type.includes("completed")) {
    result.toolResult = { toolUseId: String(item.id as string | number) };
  }
}

function applyAssistantFallbackText(c: CopilotCtx): void {
  const { obj, data, result, context } = c;
  const assistantText = extractCopilotAssistantText(obj);
  if (assistantText && !result.displayEvents?.some((event) => event.kind === "assistant" && event.text === assistantText)) {
    const msgModel = getString(data ?? obj, ["model", "modelId", "model_id"]);
    if (msgModel) context.model = msgModel;
    result.assistantText = assistantText;
    pushDisplay(result, { kind: "assistant", text: assistantText, model: msgModel || context.model || "" });
  }
}

function applyTurnResult(c: CopilotCtx): void {
  const { type, obj, payload, usage, inputTokens, outputTokens, model, result } = c;
  if (!COPILOT_RESULT_TYPES.has(type)) return;
  const status = String((payload.status as string) || (payload.subtype as string) || "").toLowerCase();
  // #994: the event TYPE (e.g. "completed"/"turn.completed") is itself the
  // positive signal that a turn finished; exitCode/is_error/status only
  // downgrade that to failure when present. But if NONE of the fields this
  // computation reads are present at all under ANY known spelling, a CLI
  // rename could be silently hiding a failure signal behind success's
  // default — report that ambiguity as field drift instead of only ever
  // logging it as a quiet success.
  if (!hasCopilotSuccessSignalFields(payload)) {
    const parsed = copilotResultPayloadSchema.safeParse(payload);
    const detail = parsed.success
      ? "no exitCode/is_error/isError/error/status/subtype field present to confirm success"
      : parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    recordUnknownFieldDrift("copilot", type || "<no-type>", detail);
  }
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

  const c: CopilotCtx = { obj, type, data, payload, item, usage, inputTokens, outputTokens, model, result, context };
  applyLifecycleEvent(c);
  applyToolActivity(c);
  applyToolResult(c);
  applyAssistantFallbackText(c);
  applyTurnResult(c);

  if (!hasFields(result)) {
    if (COPILOT_IGNORED_TYPES.has(type)) {
      // Known-but-deliberately-ignored chatter (deltas, turn boundaries):
      // recognized-but-empty, so healthy noise never counts as drift (#968).
      return result;
    }
    const rawText = getString(obj, ["message", "text", "content", "status"]);
    pushDisplay(result, { kind: "raw", text: rawText || rawLine });
    unmatchedFallbackEvents.add(result);
  }

  return result;
}
