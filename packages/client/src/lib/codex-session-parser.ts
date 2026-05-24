/**
 * Parse Codex CLI session JSONL files from ~/.codex/sessions/.
 *
 * Session files use a different format from `codex exec --json` streaming:
 * - Each line is `{ timestamp, type, payload }` envelope
 * - Types: session_meta, event_msg, response_item, turn_context, compacted
 *
 * Maps session events to the same DisplayEvent types used by other parsers.
 */

import type {
  DisplayEvent,
  ParsedAssistantEvent,
  ParsedInitEvent,
  ParsedResultEvent,
  ParsedToolResultEvent,
  ParsedToolUseEvent,
} from "./claude-output-parser.js";

export interface CodexSessionStats {
  model: string;
  sessionId: string;
  cwd: string;
  cliVersion: string;
  startTime: string;
  endTime: string;
  durationSec: number;
  turns: number;
  toolCalls: number;
  filesRead: string[];
  filesWritten: string[];
  commands: string[];
  userMessages: string[];
  agentMessages: string[];
  inputTokens: number;
  outputTokens: number;
}

export class CodexSessionParser {
  private callNameMap = new Map<string, string>();
  private stats: CodexSessionStats = {
    model: "",
    sessionId: "",
    cwd: "",
    cliVersion: "",
    startTime: "",
    endTime: "",
    durationSec: 0,
    turns: 0,
    toolCalls: 0,
    filesRead: [],
    filesWritten: [],
    commands: [],
    userMessages: [],
    agentMessages: [],
    inputTokens: 0,
    outputTokens: 0,
  };

  getStats(): CodexSessionStats {
    return { ...this.stats };
  }

  parseLine(line: string): DisplayEvent[] {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }

    const type = obj.type as string;
    const payload = obj.payload as Record<string, unknown> | undefined;
    const timestamp = obj.timestamp as string;

    if (timestamp) {
      if (!this.stats.startTime) this.stats.startTime = timestamp;
      this.stats.endTime = timestamp;
    }

    switch (type) {
      case "session_meta":
        return this.parseSessionMeta(payload);
      case "event_msg":
        return this.parseEventMsg(payload);
      case "response_item":
        return this.parseResponseItem(payload);
      case "turn_context":
        return this.parseTurnContext(payload);
      case "compacted":
        return [];
      default:
        return [];
    }
  }

  private parseSessionMeta(payload: Record<string, unknown> | undefined): DisplayEvent[] {
    if (!payload) return [];
    this.stats.sessionId = (payload.id as string) || "";
    this.stats.cwd = (payload.cwd as string) || "";
    this.stats.cliVersion = (payload.cli_version as string) || "";

    const baseInstructions = payload.base_instructions as Record<string, unknown> | undefined;
    const text = baseInstructions?.text as string || "";

    return [{
      kind: "init",
      model: (payload.model_provider as string) || "codex",
      sessionId: this.stats.sessionId,
      cwd: this.stats.cwd,
      tools: [],
      mcpServers: [],
      permissionMode: "",
    } satisfies ParsedInitEvent];
  }

  private parseEventMsg(payload: Record<string, unknown> | undefined): DisplayEvent[] {
    if (!payload) return [];
    const msgType = payload.type as string;

    if (msgType === "user_message") {
      const text = (payload.message as string) || "";
      if (text) this.stats.userMessages.push(text);
      return [];
    }

    if (msgType === "agent_message") {
      const text = (payload.message as string) || "";
      if (text) {
        this.stats.agentMessages.push(text);
        return [{ kind: "assistant", text, model: this.stats.model || "codex" } satisfies ParsedAssistantEvent];
      }
      return [];
    }

    if (msgType === "task_started") {
      this.stats.turns++;
      return [];
    }

    if (msgType === "task_complete") {
      const lastMsg = (payload.last_agent_message as string) || "";
      return [{
        kind: "result",
        success: true,
        durationMs: 0,
        result: lastMsg,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: this.stats.model || "codex",
      } satisfies ParsedResultEvent];
    }

    if (msgType === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      if (info) {
        const total = info.total_token_usage as Record<string, unknown> | undefined;
        if (total) {
          this.stats.inputTokens = (total.input_tokens as number) || 0;
          this.stats.outputTokens = (total.output_tokens as number) || 0;
        }
      }
      return [];
    }

    if (msgType === "patch_apply_end") {
      const callId = (payload.call_id as string) || "";
      const stdout = (payload.stdout as string) || "";
      const success = payload.success !== false;
      const changes = payload.changes as Record<string, Record<string, string>> | undefined;

      const changedFiles = changes ? Object.keys(changes) : [];
      for (const f of changedFiles) {
        this.stats.filesWritten.push(f.replace(/^[A-Z]:\\/i, ""));
      }

      return [{
        kind: "tool_result",
        toolName: "apply_patch",
        toolUseId: callId,
        output: stdout,
        isError: !success,
      } satisfies ParsedToolResultEvent];
    }

    if (msgType === "web_search_end") {
      const callId = (payload.call_id as string) || "";
      const query = (payload.query as string) || "";
      return [{
        kind: "tool_result",
        toolName: "web_search",
        toolUseId: callId,
        output: query,
        isError: false,
      } satisfies ParsedToolResultEvent];
    }

    return [];
  }

  private parseResponseItem(payload: Record<string, unknown> | undefined): DisplayEvent[] {
    if (!payload) return [];
    const riType = payload.type as string;

    if (riType === "message") {
      const role = (payload.role as string) || "";
      if (role !== "assistant") return [];
      const content = payload.content as Array<Record<string, unknown>> | undefined;
      if (!content) return [];
      const texts: string[] = [];
      for (const block of content) {
        if (block.type === "output_text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      if (!texts.length) return [];
      const text = texts.join("\n");
      this.stats.agentMessages.push(text);
      return [{ kind: "assistant", text, model: this.stats.model || "codex" } satisfies ParsedAssistantEvent];
    }

    if (riType === "reasoning") {
      return [];
    }

    if (riType === "function_call") {
      const name = (payload.name as string) || "";
      const callId = (payload.call_id as string) || "";
      const args = (payload.arguments as string) || "";
      this.callNameMap.set(callId, name);
      this.stats.toolCalls++;

      let inputParsed: Record<string, unknown> = {};
      try { inputParsed = JSON.parse(args); } catch { /* keep empty */ }

      if (name === "shell_command" && inputParsed.command) {
        this.stats.commands.push(inputParsed.command as string);
      }

      return [{
        kind: "tool_use",
        id: callId,
        name,
        input: args,
        inputParsed,
      } satisfies ParsedToolUseEvent];
    }

    if (riType === "function_call_output") {
      const callId = (payload.call_id as string) || "";
      const output = (payload.output as string) || "";
      const toolName = this.callNameMap.get(callId) || "function";

      this.trackFileAccessFromOutput(toolName, output);

      return [{
        kind: "tool_result",
        toolName,
        toolUseId: callId,
        output,
        isError: false,
      } satisfies ParsedToolResultEvent];
    }

    if (riType === "custom_tool_call") {
      const name = (payload.name as string) || "custom_tool";
      const callId = (payload.call_id as string) || "";
      const input = (payload.input as string) || "";
      this.callNameMap.set(callId, name);
      this.stats.toolCalls++;
      return [{
        kind: "tool_use",
        id: callId,
        name,
        input,
        inputParsed: { input },
      } satisfies ParsedToolUseEvent];
    }

    if (riType === "custom_tool_call_output") {
      const callId = (payload.call_id as string) || "";
      const output = (payload.output as string) || "";
      const toolName = this.callNameMap.get(callId) || "custom_tool";
      return [{
        kind: "tool_result",
        toolName,
        toolUseId: callId,
        output,
        isError: false,
      } satisfies ParsedToolResultEvent];
    }

    if (riType === "web_search_call") {
      const action = payload.action as Record<string, unknown> | undefined;
      const queries = (action?.queries as string[]) || [];
      return [{
        kind: "tool_use",
        id: "",
        name: "web_search",
        input: queries.join("; "),
        inputParsed: { queries },
      } satisfies ParsedToolUseEvent];
    }

    return [];
  }

  private parseTurnContext(payload: Record<string, unknown> | undefined): DisplayEvent[] {
    if (!payload) return [];
    const model = (payload.model as string) || "";
    if (model) this.stats.model = model;
    return [];
  }

  private trackFileAccessFromOutput(toolName: string, output: string): void {
    if (toolName !== "shell_command" && toolName !== "read_file" && toolName !== "write_file") return;

    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Track files read via Get-Content, cat, etc.
      if (/^(Get-Content|cat|type|head)\s/i.test(trimmed)) {
        const match = trimmed.match(/(?:Get-Content|cat|type|head)\s+(?:-[A-Za-z]+\s+)*["']?([^\s"']+)/i);
        if (match?.[1]) this.stats.filesRead.push(match[1]);
      }
    }
  }
}

/**
 * Parse an entire Codex session JSONL file and return events + stats.
 * Streams line-by-line to handle large files efficiently.
 */
export function parseCodexSession(lines: string[]): { events: DisplayEvent[]; stats: CodexSessionStats } {
  const parser = new CodexSessionParser();
  const events: DisplayEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(...parser.parseLine(trimmed));
  }

  // Calculate duration
  const stats = parser.getStats();
  if (stats.startTime && stats.endTime) {
    const start = new Date(stats.startTime).getTime();
    const end = new Date(stats.endTime).getTime();
    stats.durationSec = Math.round((end - start) / 1000);
  }

  return { events, stats };
}
