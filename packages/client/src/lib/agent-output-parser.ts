import { ClaudeOutputParser, type DisplayEvent } from "./claude-output-parser.js";
import { CodexOutputParser } from "./codex-output-parser.js";
import { PiOutputParser } from "./pi-output-parser.js";
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
import {
  asRecord,
  contentToText,
  extractAssistantText,
  extractResult,
  extractToolResult,
  extractToolUse,
  formatShutdownResult,
  getString,
  getStringArray,
  IGNORED_COPILOT_TYPES,
  normalizedType,
  SESSION_START_TYPES,
} from "./copilot-event-extractors.js";

export type { DisplayEvent } from "./claude-output-parser.js";

export type AgentOutputFormat = "claude-stream-json" | "codex-jsonl" | "copilot-jsonl" | "pi-jsonl" | "raw";

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

/** Normalized view of one parsed Copilot JSONL event, shared by all handlers. */
interface CopilotEventContext {
  type: string;
  obj: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
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

  /**
   * Dispatches an event through the ordered handler chain. Each handler
   * returns `null` when the event is not its kind (fall through to the next)
   * or a (possibly empty) event array when it handled the event. Handler
   * order matters: it mirrors the original if-ladder semantics exactly.
   */
  private parseEvent(obj: Record<string, unknown>, rawLine: string): DisplayEvent[] {
    const ctx: CopilotEventContext = {
      type: normalizedType(obj),
      obj,
      data: asRecord(obj.data),
    };

    return this.handleSessionStart(ctx)
      ?? this.handleSessionModelChange(ctx)
      ?? this.handleSessionShutdown(ctx)
      ?? this.handleUserMessage(ctx)
      ?? this.handleAssistantReasoning(ctx)
      ?? this.handleIgnoredType(ctx)
      ?? this.handleAssistantMessage(ctx)
      ?? this.handleExtractedAssistantText(ctx)
      ?? this.handleSubagentStarted(ctx)
      ?? this.handleSubagentCompleted(ctx)
      ?? this.handleSystemNotification(ctx)
      ?? this.handleExtractedToolUse(ctx)
      ?? this.handleExtractedToolResult(ctx)
      ?? this.handleExtractedResult(ctx)
      ?? this.handleRawFallback(ctx, rawLine);
  }

  private handleSessionStart({ type, obj, data }: CopilotEventContext): DisplayEvent[] | null {
    if (!type || !SESSION_START_TYPES.has(type)) return null;
    return [this.extractSessionStartPayload(data || obj, obj)];
  }

  private extractSessionStartPayload(
    payload: Record<string, unknown>,
    obj: Record<string, unknown>,
  ): ParsedInitEvent {
    const context = asRecord(payload.context);
    const cwd = getString(payload, ["cwd", "working_directory", "workingDirectory"])
      || getString(context || {}, ["cwd", "working_directory", "workingDirectory"])
      || "";
    const model = getString(payload, ["model", "modelId", "model_id"])
      || getString(context || {}, ["model", "modelId", "model_id"])
      || this.model || "copilot";
    return {
      kind: "init",
      model,
      sessionId: getString(payload, ["session_id", "sessionId", "sessionID", "id"]) || getString(obj, ["id"]),
      cwd,
      tools: getStringArray(payload.tools),
      mcpServers: [],
      permissionMode: getString(payload, ["permissionMode", "permission_mode"]) || "",
    };
  }

  private handleSessionModelChange({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "session.model_change" || !data) return null;
    const newModel = getString(data, ["newModel", "model", "modelId", "model_id"]);
    if (newModel) this.model = newModel;
    return [];
  }

  private handleSessionShutdown({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "session.shutdown" || !data) return null;
    const codeChanges = asRecord(data.codeChanges);
    const filesModified = Array.isArray(codeChanges?.filesModified)
      ? (codeChanges.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const linesAdded = Number(codeChanges?.linesAdded ?? 0);
    const linesRemoved = Number(codeChanges?.linesRemoved ?? 0);
    const durationMs = Number(data.totalApiDurationMs ?? 0);
    const shutdownType = String(data.shutdownType || "");
    return [{
      kind: "result",
      success: shutdownType !== "error" && shutdownType !== "abrupt",
      durationMs,
      result: formatShutdownResult(shutdownType, linesAdded, linesRemoved, filesModified),
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: this.model || "",
    } satisfies ParsedResultEvent];
  }

  private handleUserMessage({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "user.message" || !data) return null;
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

  private handleAssistantReasoning({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "assistant.reasoning") return null;
    const text = data ? getString(data, ["content", "text"]) : "";
    return text ? [{ kind: "thinking", text } satisfies DisplayEvent] : [];
  }

  private handleIgnoredType({ type }: CopilotEventContext): DisplayEvent[] | null {
    return IGNORED_COPILOT_TYPES.has(type) ? [] : null;
  }

  /** Handles assistant.message as a unified block: reasoning + content + tool registration. */
  private handleAssistantMessage({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "assistant.message" || !data) return null;
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

  private handleExtractedAssistantText({ obj, data }: CopilotEventContext): DisplayEvent[] | null {
    const assistantText = extractAssistantText(obj);
    if (!assistantText) return null;
    const msgModel = getString(data || obj, ["model", "modelId", "model_id"]);
    if (msgModel) this.model = msgModel;
    return [{
      kind: "assistant",
      text: assistantText,
      model: msgModel || this.model || "",
    } satisfies ParsedAssistantEvent];
  }

  private handleSubagentStarted({ type, obj, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "subagent.started" || !data) return null;
    return [{
      kind: "task_started",
      taskId: getString(obj, ["agentId"]) || getString(data, ["agentName"]) || getString(data, ["toolCallId"]),
      toolUseId: getString(data, ["toolCallId"]),
      description: getString(data, ["agentDisplayName", "agentDescription", "agentName"]),
      taskType: getString(data, ["agentName"]),
    } satisfies ParsedTaskStartedEvent];
  }

  private handleSubagentCompleted({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "subagent.completed" || !data) return null;
    const toolUseId = getString(data, ["toolCallId"]);
    return [{
      kind: "tool_result",
      toolName: toolUseId ? this.toolNameMap.get(toolUseId) || "Agent" : "Agent",
      toolUseId,
      output: `${getString(data, ["agentDisplayName", "agentName"]) || "Subagent"} completed`,
      isError: false,
    } satisfies ParsedToolResultEvent];
  }

  private handleSystemNotification({ type, data }: CopilotEventContext): DisplayEvent[] | null {
    if (type !== "system.notification" || !data) return null;
    const kind = asRecord(data.kind);
    const text = getString(data, ["content"]).replace(/<\/?system_notification>/g, "").trim();
    return [{
      kind: "notification",
      key: getString(kind || {}, ["type", "agentId"]) || "notification",
      text,
      priority: "",
    } satisfies ParsedNotificationEvent];
  }

  private handleExtractedToolUse({ obj }: CopilotEventContext): DisplayEvent[] | null {
    const toolUse = extractToolUse(obj);
    if (!toolUse) return null;
    if (toolUse.id) this.toolNameMap.set(toolUse.id, toolUse.name);
    return [{
      kind: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
      inputParsed: toolUse.inputParsed,
    } satisfies ParsedToolUseEvent];
  }

  private handleExtractedToolResult({ obj }: CopilotEventContext): DisplayEvent[] | null {
    const toolResult = extractToolResult(obj, this.toolNameMap);
    if (!toolResult) return null;
    return [{
      kind: "tool_result",
      toolName: toolResult.toolName,
      toolUseId: toolResult.toolUseId,
      output: toolResult.output,
      isError: toolResult.isError,
    } satisfies ParsedToolResultEvent];
  }

  private handleExtractedResult({ obj }: CopilotEventContext): DisplayEvent[] | null {
    const result = extractResult(obj);
    if (!result) return null;
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

  private handleRawFallback({ obj }: CopilotEventContext, rawLine: string): DisplayEvent[] {
    const rawText = getString(obj, ["message", "text", "content", "status"]);
    return [{ kind: "raw", text: rawText || rawLine }];
  }
}

const CLAUDE_COMMANDS = ["claude", "claude.exe"];
const CODEX_COMMANDS = ["codex"];
const COPILOT_COMMANDS = ["copilot"];
const PI_COMMANDS = ["pi"];

export function getOutputFormatForProvider(provider?: string | null): AgentOutputFormat {
  if (!provider || provider === "claude") return "claude-stream-json";
  if (provider === "codex") return "codex-jsonl";
  if (provider === "copilot") return "copilot-jsonl";
  if (provider === "pi") return "pi-jsonl";
  return "raw";
}

export function getOutputFormatForAgent(agentCommand?: string): AgentOutputFormat {
  if (!agentCommand) return "claude-stream-json";
  const base = agentCommand.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, "")?.toLowerCase() ?? "";
  if (CLAUDE_COMMANDS.includes(base) || base.includes("mock-agent")) return "claude-stream-json";
  if (CODEX_COMMANDS.includes(base)) return "codex-jsonl";
  if (COPILOT_COMMANDS.includes(base)) return "copilot-jsonl";
  if (PI_COMMANDS.includes(base)) return "pi-jsonl";
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
    case "pi-jsonl":
      return new PiOutputParser();
    case "claude-stream-json":
    default:
      return new ClaudeOutputParser();
  }
}
