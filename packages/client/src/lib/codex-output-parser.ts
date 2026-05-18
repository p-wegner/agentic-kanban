/**
 * Parse Codex CLI's JSONL output format.
 *
 * Codex emits JSONL lines when run with `codex exec --json`.
 * Each line is a JSON object with a `type` field:
 * - "thread.started" — session initialization with thread_id
 * - "turn.started" / "turn.completed" / "turn.failed" — turn boundaries
 * - "item.started" / "item.updated" / "item.completed" — items within turns
 *
 * Item types:
 * - "agent_message" — text response from agent
 * - "command_execution" — shell command with output
 * - "mcp_tool_call" — MCP tool invocation
 * - "reasoning" — thinking blocks
 *
 * Maps Codex events to the same ParsedEvent types used by ClaudeOutputParser.
 */

import type {
  DisplayEvent,
  ParsedInitEvent,
  ParsedAssistantEvent,
  ParsedThinkingEvent,
  ParsedResultEvent,
  ParsedToolUseEvent,
  ParsedToolResultEvent,
} from "./claude-output-parser.js";

export class CodexOutputParser {
  readonly format = "codex-jsonl" as const;
  readonly label = "codex-jsonl";

  private buffer = "";
  private _isCodexJson = false;

  get isCodexJson(): boolean {
    return this._isCodexJson;
  }

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

  flush(): DisplayEvent[] {
    if (!this.buffer.trim()) return [];
    const events = this.parseLine(this.buffer.trim());
    this.buffer = "";
    return events;
  }

  private parseLine(line: string): DisplayEvent[] {
    try {
      const obj = JSON.parse(line);
      this._isCodexJson = true;
      return this.parseEvent(obj);
    } catch {
      return [{ kind: "raw", text: line }];
    }
  }

  private parseEvent(obj: Record<string, unknown>): DisplayEvent[] {
    const type = obj.type as string;

    // thread.started → init
    if (type === "thread.started") {
      return [{
        kind: "init",
        model: "codex",
        sessionId: (obj.thread_id as string) || "",
        cwd: "",
        tools: [],
        mcpServers: [],
        permissionMode: "",
      } satisfies ParsedInitEvent];
    }

    // item.completed with agent_message → assistant text
    if (type === "item.completed" || type === "item.updated") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item) return [];

      const itemType = item.type as string;

      if (itemType === "agent_message") {
        const text = (item.text as string) || "";
        if (!text) return [];
        return [{ kind: "assistant", text, model: "codex" } satisfies ParsedAssistantEvent];
      }

      if (itemType === "command_execution") {
        const events: DisplayEvent[] = [];
        const id = (item.id as string) || "";
        const command = (item.command as string) || "";
        const output = (item.aggregated_output as string) || "";
        const exitCode = item.exit_code as number | null;
        const status = item.status as string;

        if (command && status === "in_progress") {
          events.push({
            kind: "tool_use",
            id,
            name: "shell_command",
            input: command,
            inputParsed: { command },
          } satisfies ParsedToolUseEvent);
        }

        if (output && status === "completed") {
          events.push({
            kind: "tool_result",
            toolName: "shell_command",
            toolUseId: id,
            output,
            isError: exitCode !== null && exitCode !== 0,
          } satisfies ParsedToolResultEvent);
        }

        return events;
      }

      if (itemType === "mcp_tool_call") {
        const events: DisplayEvent[] = [];
        const id = (item.id as string) || "";
        const toolName = (item.name as string) || "mcp_tool";
        const args = (item.args as Record<string, unknown>) || {};
        const result = (item.result as string) || "";
        const itemStatus = (item.status as string) || "";

        if (itemStatus === "in_progress") {
          events.push({
            kind: "tool_use",
            id,
            name: toolName,
            input: JSON.stringify(args, null, 2),
            inputParsed: args,
          } satisfies ParsedToolUseEvent);
        }

        if (result && itemStatus === "completed") {
          events.push({
            kind: "tool_result",
            toolName,
            toolUseId: id,
            output: result,
            isError: false,
          } satisfies ParsedToolResultEvent);
        }

        return events;
      }

      if (itemType === "reasoning") {
        const text = (item.text as string) || "";
        if (text) {
          return [{ kind: "thinking", text } satisfies ParsedThinkingEvent];
        }
      }

      // file_change items — show as tool use
      if (itemType === "file_change") {
        const id = (item.id as string) || "";
        const path = (item.path as string) || "";
        return [{
          kind: "tool_use",
          id,
          name: "file_change",
          input: path,
          inputParsed: { path },
        } satisfies ParsedToolUseEvent];
      }

      return [];
    }

    // turn.completed → result
    if (type === "turn.completed") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      return [{
        kind: "result",
        success: true,
        durationMs: 0,
        result: "",
        totalCostUsd: 0,
        inputTokens: (usage?.input_tokens as number) || 0,
        outputTokens: (usage?.output_tokens as number) || 0,
        model: "codex",
      } satisfies ParsedResultEvent];
    }

    // turn.failed → error result
    if (type === "turn.failed") {
      const error = obj.error as Record<string, unknown> | undefined;
      return [{
        kind: "result",
        success: false,
        durationMs: 0,
        result: (error?.message as string) || "Turn failed",
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: "codex",
      } satisfies ParsedResultEvent];
    }

    // error
    if (type === "error") {
      return [{ kind: "raw", text: (obj.message as string) || "Error" }];
    }

    return [];
  }
}
