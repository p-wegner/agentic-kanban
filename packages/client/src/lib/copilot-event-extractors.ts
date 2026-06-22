// Pure data-extraction helpers for Copilot JSONL events.
// Used by CopilotOutputParser (agent-output-parser.ts); kept stateless and side-effect free.

export const SESSION_START_TYPES = new Set([
  "session_start",
  "session_started",
  "session_created",
  "session.start",
  "session.started",
  "session.created",
]);

export const IGNORED_COPILOT_TYPES = new Set([
  "assistant.message_start",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.turn_start",
  "assistant.turn_end",
  "session.background_tasks_changed",
  "session.mcp_servers_loaded",
  "session.skills_loaded",
  "session.warning",
  "session.tools_updated",
]);

export const TOOL_USE_TYPES = new Set([
  "tool_call",
  "tool_call_start",
  "tool_call_started",
  "tool_use",
  "tool_use_start",
  "tool_use_started",
  "tool.start",
  "tool.started",
  "tool_call.started",
]);

export const TOOL_RESULT_TYPES = new Set([
  "tool_result",
  "tool_call_result",
  "tool_call_complete",
  "tool_call_completed",
  "tool.completed",
  "tool_call.completed",
]);

export const RESULT_TYPES = new Set([
  "result",
  "done",
  "session_end",
  "session_ended",
  "session.end",
  "session.ended",
  "turn_completed",
  "turn.completed",
  "stats",
]);

export function normalizedType(obj: Record<string, unknown>): string {
  return String((obj.type as string) || (obj.event as string) || (obj.name as string) || "").toLowerCase().replace(/-/g, "_");
}

export function getString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = asRecord(block);
      return record ? getString(record, ["text", "content", "message"]) : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function formatShutdownResult(
  shutdownType: string,
  linesAdded: number,
  linesRemoved: number,
  filesModified: string[],
): string {
  return filesModified.length > 0
    ? `${shutdownType ? shutdownType + " — " : ""}+${linesAdded}/-${linesRemoved} lines in ${filesModified.length} file${filesModified.length !== 1 ? "s" : ""}`
    : (shutdownType || "");
}

export function extractAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String((obj.role as string) || "").toLowerCase();
  const data = asRecord(obj.data);
  const message = asRecord(obj.message);

  if (type === "assistant.message" && data) {
    return contentToText(data.content)
      || getString(data, ["content", "text", "message"])
      || "";
  }

  if (type === "assistant" || type === "assistant_message" || role === "assistant") {
    return contentToText(obj.content)
      || getString(obj, ["text", "message", "delta"])
      || (message ? contentToText(message.content) || getString(message, ["text", "content", "message"]) : "");
  }

  if (type === "message" && role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message"]);
  }

  return "";
}

export function extractToolUse(obj: Record<string, unknown>): {
  id: string;
  name: string;
  input: string;
  inputParsed: Record<string, unknown>;
} | null {
  const type = normalizedType(obj);
  if (!TOOL_USE_TYPES.has(type) && type !== "tool.execution_start") return null;

  const data = asRecord(obj.data);
  const tool = data || asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const id = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId"]);
  const name = getString(tool, ["name", "tool", "tool_name", "toolName", "kind"]) || "copilot_tool";
  const inputValue = tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? tool.command ?? tool.path;
  let inputParsed = asRecord(inputValue) || {};
  if (Object.keys(inputParsed).length === 0 && typeof inputValue === "string") {
    try { inputParsed = JSON.parse(inputValue) as Record<string, unknown>; } catch { /* keep empty */ }
  }

  return {
    id: id || getString(tool, ["toolCallId"]),
    name,
    input: stringifyValue(inputValue),
    inputParsed,
  };
}

export function extractToolResult(obj: Record<string, unknown>, toolNameMap: Map<string, string>): {
  toolName: string;
  toolUseId: string;
  output: string;
  isError: boolean;
} | null {
  const type = normalizedType(obj);
  if (!TOOL_RESULT_TYPES.has(type) && type !== "tool.execution_complete" && type !== "tool.execution_partial_result") return null;

  const data = asRecord(obj.data);
  const tool = data || asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const toolUseId = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId", "toolCallId"]);
  const toolName = getString(tool, ["name", "tool", "tool_name", "toolName", "kind"])
    || (toolUseId ? toolNameMap.get(toolUseId) : "")
    || "copilot_tool";
  const result = asRecord(tool.result);
  const output = stringifyValue(result?.content ?? result?.detailedContent ?? tool.output ?? tool.result ?? tool.content ?? tool.message ?? tool.error);
  const status = String((tool.status as string) || "").toLowerCase();

  return {
    toolName,
    toolUseId,
    output,
    isError: tool.success === false || Boolean(tool.is_error || tool.isError || tool.error) || status === "error" || status === "failed",
  };
}

export function extractResult(obj: Record<string, unknown>): {
  success: boolean;
  durationMs: number;
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
} | null {
  const type = normalizedType(obj);
  if (!RESULT_TYPES.has(type)) return null;

  const data = asRecord(obj.data);
  const payload = data || obj;
  const usage = asRecord(payload.usage) || asRecord(payload.stats) || payload;
  const status = String((payload.status as string) || (payload.subtype as string) || "").toLowerCase();
  return {
    success: Number(payload.exitCode ?? 0) === 0 && !(payload.is_error || payload.isError || payload.error) && status !== "error" && status !== "failed",
    durationMs: Number(payload.duration_ms ?? payload.durationMs ?? usage.sessionDurationMs ?? usage.duration_ms ?? usage.durationMs ?? 0) || 0,
    result: getString(payload, ["result", "message", "summary"]) || stringifyValue(payload.error),
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0) || 0,
    model: getString(payload, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]),
  };
}
