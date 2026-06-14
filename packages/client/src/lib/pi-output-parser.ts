/**
 * Parse Pi CLI's JSONL output format from `pi --mode json`.
 *
 * The observed Pi stream emits session headers, assistant message updates,
 * tool execution start/end records, and turn/agent boundaries.
 */

import type {
  DisplayEvent,
  ParsedAssistantEvent,
  ParsedInitEvent,
  ParsedResultEvent,
  ParsedToolResultEvent,
  ParsedToolUseEvent,
} from "./claude-output-parser.js";

interface PiMessage {
  role?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cost?: {
      total?: number;
    };
  };
  stopReason?: string;
  errorMessage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = asRecord(block);
      return typeof record?.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export class PiOutputParser {
  readonly format = "pi-jsonl" as const;
  readonly label = "pi-jsonl";

  private buffer = "";
  private model = "pi";
  private toolNameMap = new Map<string, string>();
  private lastErrorSignature = "";

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
      return this.parseEvent(JSON.parse(line) as Record<string, unknown>, line);
    } catch {
      return [{ kind: "raw", text: line }];
    }
  }

  private parseEvent(obj: Record<string, unknown>, rawLine: string): DisplayEvent[] {
    const type = obj.type;

    if (type === "session") {
      return [{
        kind: "init",
        model: this.model,
        sessionId: typeof obj.id === "string" ? obj.id : "",
        cwd: typeof obj.cwd === "string" ? obj.cwd : "",
        tools: [],
        mcpServers: [],
        permissionMode: "",
      } satisfies ParsedInitEvent];
    }

    if (type === "message_update") {
      return this.parseMessageUpdate(obj);
    }

    if (type === "tool_execution_start") {
      return this.parseToolExecutionStart(obj);
    }

    if (type === "tool_execution_end") {
      return this.parseToolExecutionEnd(obj);
    }

    if (type === "message_start" || type === "message_end" || type === "turn_end") {
      const message = asRecord(obj.message) as PiMessage | undefined;
      if (message) return this.parseMessageError(message);
      return [];
    }

    if (type === "agent_end") {
      return this.parseAgentEnd(obj);
    }

    if (type === "error") {
      return [{ kind: "raw", text: typeof obj.message === "string" ? obj.message : rawLine }];
    }

    return [];
  }

  private parseMessageUpdate(obj: Record<string, unknown>): DisplayEvent[] {
    const assistantMessageEvent = asRecord(obj.assistantMessageEvent);
    const eventType = assistantMessageEvent?.type;
    const message = asRecord(obj.message) as PiMessage | undefined;
    if (message?.model) this.model = message.model;

    if (assistantMessageEvent && eventType === "text_delta" && typeof assistantMessageEvent.delta === "string") {
      return [{
        kind: "assistant",
        text: assistantMessageEvent.delta,
        model: message?.model || this.model,
      } satisfies ParsedAssistantEvent];
    }

    return [];
  }

  private parseToolExecutionStart(obj: Record<string, unknown>): DisplayEvent[] {
    const id = typeof obj.toolCallId === "string" ? obj.toolCallId : "";
    const name = typeof obj.toolName === "string" ? obj.toolName : "pi_tool";
    const inputParsed = asRecord(obj.args) || {};
    if (id) this.toolNameMap.set(id, name);
    return [{
      kind: "tool_use",
      id,
      name,
      input: stringifyInput(obj.args),
      inputParsed,
    } satisfies ParsedToolUseEvent];
  }

  private parseToolExecutionEnd(obj: Record<string, unknown>): DisplayEvent[] {
    const toolUseId = typeof obj.toolCallId === "string" ? obj.toolCallId : "";
    const toolName = typeof obj.toolName === "string"
      ? obj.toolName
      : toolUseId ? this.toolNameMap.get(toolUseId) || "pi_tool" : "pi_tool";
    return [{
      kind: "tool_result",
      toolName,
      toolUseId,
      output: this.extractToolResultOutput(obj.result),
      isError: obj.isError === true,
    } satisfies ParsedToolResultEvent];
  }

  private parseMessageError(message: PiMessage): DisplayEvent[] {
    if (message.model) this.model = message.model;
    if (message.stopReason !== "error") return [];
    const signature = `${message.model || this.model}:${message.errorMessage || "Pi turn failed"}`;
    if (signature === this.lastErrorSignature) return [];
    this.lastErrorSignature = signature;

    return [{
      kind: "result",
      success: false,
      durationMs: 0,
      result: message.errorMessage || "Pi turn failed",
      totalCostUsd: message.usage?.cost?.total || 0,
      inputTokens: message.usage?.input || 0,
      outputTokens: message.usage?.output || 0,
      model: message.model || this.model,
    } satisfies ParsedResultEvent];
  }

  private parseAgentEnd(obj: Record<string, unknown>): DisplayEvent[] {
    const messages = Array.isArray(obj.messages) ? obj.messages : [];
    const lastAssistant = [...messages].reverse()
      .map((message) => asRecord(message) as PiMessage | undefined)
      .find((message) => message?.role === "assistant");
    if (!lastAssistant) return [];
    if (lastAssistant.model) this.model = lastAssistant.model;
    const result = lastAssistant.stopReason === "error" ? lastAssistant.errorMessage || "Pi turn failed" : "";
    const signature = `${lastAssistant.model || this.model}:${result}`;
    if (lastAssistant.stopReason === "error" && signature === this.lastErrorSignature) return [];
    if (lastAssistant.stopReason === "error") this.lastErrorSignature = signature;

    return [{
      kind: "result",
      success: lastAssistant.stopReason !== "error",
      durationMs: 0,
      result,
      totalCostUsd: lastAssistant.usage?.cost?.total || 0,
      inputTokens: lastAssistant.usage?.input || 0,
      outputTokens: lastAssistant.usage?.output || 0,
      model: lastAssistant.model || this.model,
    } satisfies ParsedResultEvent];
  }

  private extractToolResultOutput(result: unknown): string {
    const resultRecord = asRecord(result);
    if (!resultRecord) return stringifyInput(result);
    const text = contentToText(resultRecord.content);
    return text || stringifyInput(result);
  }
}
