import { ClaudeOutputParser, type DisplayEvent } from "./claude-output-parser.js";
import { CodexOutputParser } from "./codex-output-parser.js";
import type {
  ParsedAssistantEvent,
  ParsedInitEvent,
  ParsedResultEvent,
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

    if (type && SESSION_START_TYPES.has(type)) {
      return [{
        kind: "init",
        model: getString(obj, ["model", "modelId", "model_id"]) || "copilot",
        sessionId: getString(obj, ["session_id", "sessionId", "sessionID", "id"]) || "",
        cwd: getString(obj, ["cwd", "working_directory", "workingDirectory"]) || "",
        tools: getStringArray(obj.tools),
        mcpServers: [],
        permissionMode: getString(obj, ["permissionMode", "permission_mode"]) || "",
      } satisfies ParsedInitEvent];
    }

    const assistantText = extractAssistantText(obj);
    if (assistantText) {
      return [{
        kind: "assistant",
        text: assistantText,
        model: getString(obj, ["model", "modelId", "model_id"]) || "",
      } satisfies ParsedAssistantEvent];
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
  return String(obj.type || obj.event || obj.name || "").toLowerCase();
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
  const message = asRecord(obj.message);

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
  if (!TOOL_USE_TYPES.has(type)) return null;

  const tool = asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const id = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId"]);
  const name = getString(tool, ["name", "tool", "tool_name", "toolName", "kind"]) || "copilot_tool";
  const inputValue = tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? tool.command ?? tool.path;
  const inputParsed = asRecord(inputValue) || {};

  return {
    id,
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
  if (!TOOL_RESULT_TYPES.has(type)) return null;

  const tool = asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const toolUseId = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId"]);
  const toolName = getString(tool, ["name", "tool", "tool_name", "toolName", "kind"])
    || (toolUseId ? toolNameMap.get(toolUseId) : "")
    || "copilot_tool";
  const output = stringifyValue(tool.output ?? tool.result ?? tool.content ?? tool.message ?? tool.error);
  const status = String(tool.status || "").toLowerCase();

  return {
    toolName,
    toolUseId,
    output,
    isError: Boolean(tool.is_error || tool.isError || tool.error) || status === "error" || status === "failed",
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

  const usage = asRecord(obj.usage) || asRecord(obj.stats) || obj;
  const status = String(obj.status || obj.subtype || "").toLowerCase();
  return {
    success: !Boolean(obj.is_error || obj.isError || obj.error) && status !== "error" && status !== "failed",
    durationMs: Number(obj.duration_ms ?? obj.durationMs ?? usage.duration_ms ?? usage.durationMs ?? 0) || 0,
    result: getString(obj, ["result", "message", "summary"]) || stringifyValue(obj.error),
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0) || 0,
    model: getString(obj, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]),
  };
}
