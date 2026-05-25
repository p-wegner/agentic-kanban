import { ClaudeOutputParser, type DisplayEvent } from "./claude-output-parser.js";
import { CodexOutputParser } from "./codex-output-parser.js";
import type {
  ParsedAssistantEvent,
  ParsedInitEvent,
  ParsedNotificationEvent,
  ParsedResultEvent,
  ParsedTaskStartedEvent,
  ParsedThinkingEvent,
  ParsedToolResultEvent,
  ParsedToolUseEvent,
} from "./claude-output-parser.js";

export type { DisplayEvent } from "./claude-output-parser.js";

export type AgentOutputFormat = "claude-stream-json" | "codex-jsonl" | "copilot-jsonl" | "raw";

export interface AgentOutputParser {
  readonly format: AgentOutputFormat;
  readonly label: string;
  feed(data: string): DisplayEvent[];
  flush(): DisplayEvent[];
}

export class RawOutputParser implements AgentOutputParser {
  readonly format = "raw";
  readonly label = "raw";

  private buffer = "";

  feed(data: string): DisplayEvent[] {
    this.buffer += data;
    const events: DisplayEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        events.push({ kind: "raw", text: line });
      }
    }

    return events;
  }

  flush(): DisplayEvent[] {
    if (!this.buffer) return [];
    const text = this.buffer;
    this.buffer = "";
    return [{ kind: "raw", text }];
  }
}

export class CopilotOutputParser implements AgentOutputParser {
  readonly format = "copilot-jsonl";
  readonly label = "copilot-jsonl";

  private buffer = "";
  private toolNameMap = new Map<string, string>();
  private model = "";

  feed(data: string): DisplayEvent[] {
    this.buffer += data;
    const events: DisplayEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      events.push(...this.parseLine(line));
    }

    return events;
  }

  flush(): DisplayEvent[] {
    if (!this.buffer.trim()) return [];
    const events = this.parseLine(this.buffer.trim());
    this.buffer = "";
    return events;
  }

  private parseLine(line: string): DisplayEvent[] {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      return this.parseEvent(obj, line);
    } catch {
      return [{ kind: "raw", text: line }];
    }
  }

  private parseEvent(obj: Record<string, unknown>, rawLine: string): DisplayEvent[] {
    const type = normalizedType(obj);
    const data = asRecord(obj.data);

    if (type && SESSION_START_TYPES.has(type)) {
      const payload = data || obj;
      const context = asRecord(payload.context);
      const cwd = getString(payload, ["cwd", "working_directory", "workingDirectory"])
        || getString(context || {}, ["cwd", "working_directory", "workingDirectory"])
        || "";
      const model = getString(payload, ["model", "modelId", "model_id"])
        || getString(context || {}, ["model", "modelId", "model_id"])
        || this.model || "copilot";
      return [{
        kind: "init",
        model,
        sessionId: getString(payload, ["session_id", "sessionId", "sessionID", "id"]) || getString(obj, ["id"]),
        cwd,
        tools: getStringArray(payload.tools),
        mcpServers: [],
        permissionMode: getString(payload, ["permissionMode", "permission_mode"]) || "",
      } satisfies ParsedInitEvent];
    }

    if (type === "session.model_change" && data) {
      const newModel = getString(data, ["newModel", "model", "modelId", "model_id"]);
      if (newModel) this.model = newModel;
      return [];
    }

    if (type === "session.shutdown" && data) {
      const codeChanges = asRecord(data.codeChanges);
      const filesModified = Array.isArray(codeChanges?.filesModified)
        ? (codeChanges.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
        : [];
      const linesAdded = Number(codeChanges?.linesAdded ?? 0);
      const linesRemoved = Number(codeChanges?.linesRemoved ?? 0);
      const durationMs = Number(data.totalApiDurationMs ?? 0);
      const shutdownType = String(data.shutdownType || "");
      const resultText = filesModified.length > 0
        ? `${shutdownType ? shutdownType + " — " : ""}+${linesAdded}/-${linesRemoved} lines in ${filesModified.length} file${filesModified.length !== 1 ? "s" : ""}`
        : (shutdownType || "");
      return [{
        kind: "result",
        success: shutdownType !== "error" && shutdownType !== "abrupt",
        durationMs,
        result: resultText,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: this.model || "",
      } satisfies ParsedResultEvent];
    }

    if (type === "user.message" && data) {
      const content = getString(data, ["content"]);
      if (content) {
        const firstLine = content.split("\n")[0].trim();
        const truncated = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
        return [{
          kind: "notification",
          key: "user",
          text: truncated,
          priority: "user",
        } satisfies ParsedNotificationEvent];
      }
      return [];
    }

    if (type === "assistant.reasoning") {
      const text = data ? getString(data, ["content", "text"]) : "";
      return text ? [{ kind: "thinking", text } satisfies DisplayEvent] : [];
    }

    if (IGNORED_COPILOT_TYPES.has(type)) {
      return [];
    }

    // Handle assistant.message as a unified block: reasoning + content + tool registration
    if (type === "assistant.message" && data) {
      const events: DisplayEvent[] = [];
      const msgModel = getString(data, ["model", "modelId", "model_id"]);
      if (msgModel) this.model = msgModel;

      // Emit reasoning/thinking if present (agent's chain-of-thought)
      const reasoningText = getString(data, ["reasoningText", "reasoning_text"]);
      if (reasoningText) {
        events.push({ kind: "thinking", text: reasoningText } satisfies ParsedThinkingEvent);
      }

      // Emit assistant content if present
      const contentText = contentToText(data.content) || getString(data, ["content", "text", "message"]);
      if (contentText) {
        events.push({ kind: "assistant", text: contentText, model: msgModel || this.model || "" } satisfies ParsedAssistantEvent);
      }

      // Register tool names from toolRequests for later tool_result name resolution
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      for (const tr of toolRequests) {
        const trObj = asRecord(tr);
        if (!trObj) continue;
        const callId = getString(trObj, ["toolCallId", "id", "call_id"]);
        const toolName = getString(trObj, ["name"]);
        if (callId && toolName) this.toolNameMap.set(callId, toolName);
      }

      return events;
    }

    const assistantText = extractAssistantText(obj);
    if (assistantText) {
      const msgModel = getString(data || obj, ["model", "modelId", "model_id"]);
      if (msgModel) this.model = msgModel;
      return [{
        kind: "assistant",
        text: assistantText,
        model: msgModel || this.model || "",
      } satisfies ParsedAssistantEvent];
    }

    if (type === "subagent.started" && data) {
      return [{
        kind: "task_started",
        taskId: getString(obj, ["agentId"]) || getString(data, ["agentName"]) || getString(data, ["toolCallId"]),
        toolUseId: getString(data, ["toolCallId"]),
        description: getString(data, ["agentDisplayName", "agentDescription", "agentName"]),
        taskType: getString(data, ["agentName"]),
      } satisfies ParsedTaskStartedEvent];
    }

    if (type === "subagent.completed" && data) {
      const toolUseId = getString(data, ["toolCallId"]);
      return [{
        kind: "tool_result",
        toolName: toolUseId ? this.toolNameMap.get(toolUseId) || "Agent" : "Agent",
        toolUseId,
        output: `${getString(data, ["agentDisplayName", "agentName"]) || "Subagent"} completed`,
        isError: false,
      } satisfies ParsedToolResultEvent];
    }

    if (type === "system.notification" && data) {
      const kind = asRecord(data.kind);
      const text = getString(data, ["content"]).replace(/<\/?system_notification>/g, "").trim();
      return [{
        kind: "notification",
        key: getString(kind || {}, ["type", "agentId"]) || "notification",
        text,
        priority: "",
      } satisfies ParsedNotificationEvent];
    }

    const toolUse = extractToolUse(obj);
    if (toolUse) {
      if (toolUse.id) this.toolNameMap.set(toolUse.id, toolUse.name);
      return [{
        kind: "tool_use",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        inputParsed: toolUse.inputParsed,
      } satisfies ParsedToolUseEvent];
    }

    const toolResult = extractToolResult(obj, this.toolNameMap);
    if (toolResult) {
      return [{
        kind: "tool_result",
        toolName: toolResult.toolName,
        toolUseId: toolResult.toolUseId,
        output: toolResult.output,
        isError: toolResult.isError,
      } satisfies ParsedToolResultEvent];
    }

    const result = extractResult(obj);
    if (result) {
      return [{
        kind: "result",
        success: result.success,
        durationMs: result.durationMs,
        result: result.result,
        totalCostUsd: 0,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
      } satisfies ParsedResultEvent];
    }

    const rawText = getString(obj, ["message", "text", "content", "status"]);
    return [{ kind: "raw", text: rawText || rawLine }];
  }
}

const CLAUDE_COMMANDS = ["claude", "claude.exe"];
const CODEX_COMMANDS = ["codex"];
const COPILOT_COMMANDS = ["copilot"];

export function getOutputFormatForProvider(provider?: string | null): AgentOutputFormat {
  if (!provider || provider === "claude") return "claude-stream-json";
  if (provider === "codex") return "codex-jsonl";
  if (provider === "copilot") return "copilot-jsonl";
  return "raw";
}

export function getOutputFormatForAgent(agentCommand?: string): AgentOutputFormat {
  if (!agentCommand) return "claude-stream-json";
  const base = agentCommand.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, "")?.toLowerCase() ?? "";
  if (CLAUDE_COMMANDS.includes(base) || base.includes("mock-agent")) return "claude-stream-json";
  if (CODEX_COMMANDS.includes(base)) return "codex-jsonl";
  if (COPILOT_COMMANDS.includes(base)) return "copilot-jsonl";
  return "raw";
}

export function createAgentOutputParser(format: AgentOutputFormat = "claude-stream-json"): AgentOutputParser {
  switch (format) {
    case "raw":
      return new RawOutputParser();
    case "codex-jsonl":
      return new CodexOutputParser();
    case "copilot-jsonl":
      return new CopilotOutputParser();
    case "claude-stream-json":
    default:
      return new ClaudeOutputParser();
  }
}

const SESSION_START_TYPES = new Set([
  "session_start",
  "session_started",
  "session_created",
  "session.start",
  "session.started",
  "session.created",
]);

const IGNORED_COPILOT_TYPES = new Set([
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

const TOOL_USE_TYPES = new Set([
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

const TOOL_RESULT_TYPES = new Set([
  "tool_result",
  "tool_call_result",
  "tool_call_complete",
  "tool_call_completed",
  "tool.completed",
  "tool_call.completed",
]);

const RESULT_TYPES = new Set([
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

function normalizedType(obj: Record<string, unknown>): string {
  return String(obj.type || obj.event || obj.name || "").toLowerCase().replace(/-/g, "_");
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function contentToText(value: unknown): string {
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

function extractAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String(obj.role || "").toLowerCase();
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

function extractToolUse(obj: Record<string, unknown>): {
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

function extractToolResult(obj: Record<string, unknown>, toolNameMap: Map<string, string>): {
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
  const status = String(tool.status || "").toLowerCase();

  return {
    toolName,
    toolUseId,
    output,
    isError: tool.success === false || Boolean(tool.is_error || tool.isError || tool.error) || status === "error" || status === "failed",
  };
}

function extractResult(obj: Record<string, unknown>): {
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
  const status = String(payload.status || payload.subtype || "").toLowerCase();
  return {
    success: Number(payload.exitCode ?? 0) === 0 && !Boolean(payload.is_error || payload.isError || payload.error) && status !== "error" && status !== "failed",
    durationMs: Number(payload.duration_ms ?? payload.durationMs ?? usage.sessionDurationMs ?? usage.duration_ms ?? usage.durationMs ?? 0) || 0,
    result: getString(payload, ["result", "message", "summary"]) || stringifyValue(payload.error),
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0) || 0,
    model: getString(payload, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]),
  };
}
