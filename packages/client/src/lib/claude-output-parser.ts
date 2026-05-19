/**
 * Parse Claude Code's stream-json output format.
 *
 * Claude emits NDJSON lines when run with --output-format stream-json --verbose.
 * Each line is a JSON object with a `type` field:
 * - "system" (subtype: "init") — session initialization
 * - "assistant" — assistant message with content array (text, thinking, tool_use)
 * - "user" — user/tool-result messages (tool_result content blocks)
 * - "result" — final result with cost/duration stats
 *
 * Raw stdout chunks may contain partial lines or multiple lines.
 * This parser accumulates partial data and emits structured ParsedEvents.
 */

export interface ParsedInitEvent {
  kind: "init";
  model: string;
  sessionId: string;
  cwd: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
}

export interface ParsedAssistantEvent {
  kind: "assistant";
  text: string;
  model: string;
}

export interface ParsedThinkingEvent {
  kind: "thinking";
  text: string;
}

export interface ParsedResultEvent {
  kind: "result";
  success: boolean;
  durationMs: number;
  result: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ParsedToolUseEvent {
  kind: "tool_use";
  id: string;
  name: string;
  input: string;
  inputParsed: Record<string, unknown>;
}

export interface ParsedToolResultEvent {
  kind: "tool_result";
  toolName: string;
  toolUseId: string;
  output: string;
  isError: boolean;
}

export interface ParsedTaskStartedEvent {
  kind: "task_started";
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: string;
}

export interface ParsedNotificationEvent {
  kind: "notification";
  key: string;
  text: string;
  priority: string;
}

export type ParsedEvent =
  | ParsedInitEvent
  | ParsedAssistantEvent
  | ParsedThinkingEvent
  | ParsedResultEvent
  | ParsedToolUseEvent
  | ParsedToolResultEvent
  | ParsedTaskStartedEvent
  | ParsedNotificationEvent;

export interface RawTextEvent {
  kind: "raw";
  text: string;
}

export type DisplayEvent = ParsedEvent | RawTextEvent;

/**
 * Accumulates raw stdout data and emits parsed events.
 * Handles partial lines from chunked stdout.
 */
export class ClaudeOutputParser {
  readonly format = "claude-stream-json";
  readonly label = "stream-json";

  private buffer = "";
  private _isClaudeJson = false;
  private toolNameMap = new Map<string, string>();

  /** Whether we've detected Claude stream-json output */
  get isClaudeJson(): boolean {
    return this._isClaudeJson;
  }

  /** Feed raw stdout data, returns parsed display events */
  feed(data: string): DisplayEvent[] {
    this.buffer += data;
    const events: DisplayEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      for (const event of this.parseLine(line)) {
        events.push(event);
      }
    }

    return events;
  }

  /** Flush any remaining buffered data */
  flush(): DisplayEvent[] {
    if (!this.buffer.trim()) return [];
    const events = this.parseLine(this.buffer.trim());
    this.buffer = "";
    return events;
  }

  private parseLine(line: string): DisplayEvent[] {
    try {
      const obj = JSON.parse(line);
      this._isClaudeJson = true;
      return this.parseJsonObject(obj);
    } catch {
      return [{ kind: "raw", text: line }];
    }
  }

  private parseJsonObject(obj: Record<string, unknown>): DisplayEvent[] {
    const type = obj.type as string;

    if (type === "system") {
      const subtype = obj.subtype as string;
      if (subtype === "init") {
        return [{
          kind: "init",
          model: (obj.model as string) || "unknown",
          sessionId: (obj.session_id as string) || "",
          cwd: (obj.cwd as string) || "",
          tools: (obj.tools as string[]) || [],
          mcpServers: (obj.mcp_servers as { name: string; status: string }[]) || [],
          permissionMode: (obj.permissionMode as string) || "",
        }];
      }
      if (subtype === "task_started") {
        return [{
          kind: "task_started",
          taskId: (obj.task_id as string) || "",
          toolUseId: (obj.tool_use_id as string) || "",
          description: (obj.description as string) || "",
          taskType: (obj.task_type as string) || "",
        }];
      }
      if (subtype === "notification") {
        return [{
          kind: "notification",
          key: (obj.key as string) || "",
          text: (obj.text as string) || "",
          priority: (obj.priority as string) || "",
        }];
      }
      if (subtype === "status") {
        const text = (obj.status as string) || (obj.message as string) || "";
        if (text) return [{ kind: "raw", text: `[status] ${text}` }];
        return [];
      }
      if (subtype === "task_progress") {
        const msg = (obj.message as string) || (obj.progress as string) || "";
        if (msg) return [{ kind: "raw", text: `[progress] ${msg}` }];
        return [];
      }
      return [];
    }

    if (type === "assistant") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];
      const model = (message?.model as string) || "";
      const events: ParsedEvent[] = [];

      for (const block of content) {
        const blockType = block.type as string;

        if (blockType === "thinking") {
          const thinking = (block.thinking as string) || "";
          if (thinking) {
            events.push({ kind: "thinking", text: thinking });
          }
        } else if (blockType === "text") {
          const text = (block.text as string) || "";
          if (text) {
            events.push({ kind: "assistant", text, model });
          }
        } else if (blockType === "tool_use") {
          const toolUseId = (block.id as string) || "";
          const toolName = (block.name as string) || "unknown";
          if (toolUseId) {
            this.toolNameMap.set(toolUseId, toolName);
          }
          events.push({
            kind: "tool_use",
            id: toolUseId,
            name: toolName,
            input: JSON.stringify(block.input, null, 2),
            inputParsed: (typeof block.input === "object" && block.input !== null && !Array.isArray(block.input))
              ? block.input as Record<string, unknown>
              : {},
          });
        }
      }

      return events;
    }

    if (type === "user") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];
      const events: ParsedEvent[] = [];

      for (const block of content) {
        if (block.type === "tool_result") {
          const rawContent = block.content;
          let output: string;
          if (typeof rawContent === "string") {
            output = rawContent;
          } else if (Array.isArray(rawContent)) {
            // Content blocks array: extract text parts
            const textParts = (rawContent as Array<Record<string, unknown>>)
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string);
            output = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(rawContent);
          } else {
            output = JSON.stringify(rawContent);
          }
          const toolUseId = (block.tool_use_id as string) || "";
          const toolName = toolUseId
            ? (this.toolNameMap.get(toolUseId) || `tool_${toolUseId}`)
            : "unknown";
          events.push({
            kind: "tool_result",
            toolName,
            toolUseId,
            output,
            isError: (block.is_error as boolean) || false,
          });
        }
      }

      return events.length > 0 ? events : [];
    }

    if (type === "result") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const modelUsage = obj.modelUsage as Record<string, Record<string, unknown>> | undefined;
      const firstModelEntry = modelUsage ? Object.entries(modelUsage)[0] : undefined;
      const firstModelUsage = firstModelEntry?.[1];
      return [{
        kind: "result",
        success: obj.subtype === "success" && !obj.is_error,
        durationMs: (obj.duration_ms as number) || 0,
        result: (obj.result as string) || "",
        totalCostUsd: (obj.total_cost_usd as number) || 0,
        inputTokens: (firstModelUsage?.inputTokens as number) || (usage?.input_tokens as number) || 0,
        outputTokens: (firstModelUsage?.outputTokens as number) || (usage?.output_tokens as number) || 0,
        model: firstModelEntry?.[0] || "",
      }];
    }

    return [{ kind: "raw", text: JSON.stringify(obj) }];
  }
}
