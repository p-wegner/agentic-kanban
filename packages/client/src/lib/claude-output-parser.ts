/**
 * Parse Claude Code's stream-json output format.
 *
 * Claude emits NDJSON lines when run with --output-format stream-json --verbose.
 * Each line is a JSON object with a `type` field:
 * - "system" (subtype: "init") — session initialization
 * - "assistant" — assistant message with content array
 * - "result" — final result with cost/duration stats
 * - "tool_use" / "tool_result" — tool invocations and results (future)
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
  name: string;
  input: string;
}

export interface ParsedToolResultEvent {
  kind: "tool_result";
  toolName: string;
  output: string;
}

export type ParsedEvent =
  | ParsedInitEvent
  | ParsedAssistantEvent
  | ParsedResultEvent
  | ParsedToolUseEvent
  | ParsedToolResultEvent;

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
  private buffer = "";
  private _isClaudeJson = false;

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

      const parsed = this.parseLine(line);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  /** Flush any remaining buffered data */
  flush(): DisplayEvent[] {
    if (!this.buffer.trim()) return [];
    const events = [this.parseLine(this.buffer.trim())].filter(
      (e): e is DisplayEvent => e !== null,
    );
    this.buffer = "";
    return events;
  }

  private parseLine(line: string): DisplayEvent | null {
    // Try parsing as JSON
    try {
      const obj = JSON.parse(line);
      this._isClaudeJson = true;
      return this.parseJsonObject(obj);
    } catch {
      // Not JSON — return as raw text
      return { kind: "raw", text: line };
    }
  }

  private parseJsonObject(obj: Record<string, unknown>): DisplayEvent | null {
    const type = obj.type as string;

    if (type === "system" && obj.subtype === "init") {
      return {
        kind: "init",
        model: (obj.model as string) || "unknown",
        sessionId: (obj.session_id as string) || "",
        cwd: (obj.cwd as string) || "",
        tools: (obj.tools as string[]) || [],
        mcpServers: (obj.mcp_servers as { name: string; status: string }[]) || [],
        permissionMode: (obj.permissionMode as string) || "",
      };
    }

    if (type === "assistant") {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];
      // Extract text from content blocks
      const textParts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .filter(Boolean);
      const toolUseParts = content.filter((c) => c.type === "tool_use");

      // Return assistant text event
      const events: ParsedEvent[] = [];
      if (textParts.length > 0) {
        events.push({
          kind: "assistant",
          text: textParts.join("\n"),
          model: (message?.model as string) || "",
        });
      }

      // Return tool use events
      for (const tool of toolUseParts) {
        events.push({
          kind: "tool_use",
          name: (tool.name as string) || "unknown",
          input: JSON.stringify(tool.input, null, 2),
        });
      }

      // Return first event; caller should handle multi-events if needed
      return events[0] || null;
    }

    if (type === "tool_result") {
      return {
        kind: "tool_result",
        toolName: (obj.tool_name as string) || "unknown",
        output: typeof obj.output === "string" ? obj.output : JSON.stringify(obj.output),
      };
    }

    if (type === "result") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const modelUsage = obj.modelUsage as Record<string, Record<string, unknown>> | undefined;
      // Get first model's usage if available
      const firstModelUsage = modelUsage ? Object.values(modelUsage)[0] : undefined;
      return {
        kind: "result",
        success: obj.subtype === "success" && !obj.is_error,
        durationMs: (obj.duration_ms as number) || 0,
        result: (obj.result as string) || "",
        totalCostUsd: (obj.total_cost_usd as number) || 0,
        inputTokens: (firstModelUsage?.inputTokens as number) || (usage?.input_tokens as number) || 0,
        outputTokens: (firstModelUsage?.outputTokens as number) || (usage?.output_tokens as number) || 0,
        model: firstModelUsage ? Object.keys(modelUsage!)[0] : "",
      };
    }

    // Unknown JSON type — show as raw
    return { kind: "raw", text: JSON.stringify(obj) };
  }
}
