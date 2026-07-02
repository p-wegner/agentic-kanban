import type { ParseContext, ParsedStreamEvent } from "./types.js";
import {
  hasFields,
  numberValue,
  objectValue,
  optionalObject,
  pushDisplay,
  registerToolName,
  stringValue,
} from "./shared.js";
import { recordUnknownAgentEvent } from "./unknown-events.js";

/**
 * Single source of truth for the codex usage-limit prose contract (#991).
 * Matches upstream English prose like "you've hit your usage limit for ...".
 * The server's codex-rate-limit service imports these \u2014 do NOT copy the regex.
 */
export const CODEX_USAGE_LIMIT_PATTERN = /you(?:['\u2019])?ve hit your usage limit for\s+(.+?)(?:\.|$)/i;
export const CODEX_RETRY_AFTER_PATTERN = /try again at\s+(.+?)(?:\.|$)/i;

export interface CodexUsageLimitMatch {
  message: string;
  retryAfter?: string;
}

export function matchCodexUsageLimitText(text: string | null | undefined): CodexUsageLimitMatch | undefined {
  if (!text || !CODEX_USAGE_LIMIT_PATTERN.test(text)) return undefined;
  return { message: text.trim(), retryAfter: CODEX_RETRY_AFTER_PATTERN.exec(text)?.[1]?.trim() };
}

function handleCodexUsageLimit(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const error = objectValue(obj.error);
  const usageLimit = matchCodexUsageLimitText(stringValue(obj.message) ?? stringValue(error.message));
  if (usageLimit) {
    result.rateLimitInfo = {
      status: "limited",
      rateLimitType: "usage_limit",
      retryAfter: usageLimit.retryAfter,
      message: usageLimit.message,
    };
  }
}

function handleCodexCommandExecution(
  item: Record<string, unknown>,
  type: unknown,
  result: ParsedStreamEvent,
  id: string,
  context: ParseContext,
): void {
  const command = stringValue(item.command) ?? "";
  if ((type === "item.started" || item.status === "in_progress") && command) {
    result.toolActivity = { name: "shell", input: { command }, toolUseId: id || undefined };
    registerToolName(context, id, "shell");
    pushDisplay(result, { kind: "tool_use", id, name: "shell", input: command, inputParsed: { command } });
  }
  if (type === "item.completed" || item.status === "completed") {
    const output = stringValue(item.aggregated_output) ?? "";
    const exitCode = item.exit_code;
    const isError = exitCode !== null && exitCode !== undefined && exitCode !== 0;
    result.toolResult = { toolUseId: id };
    if (output || isError) {
      pushDisplay(result, {
        kind: "tool_result",
        toolName: "shell",
        toolUseId: id,
        output: output || `exit code ${numberValue(exitCode)}`,
        isError,
      });
    }
  }
}

function handleCodexMcpToolCall(
  item: Record<string, unknown>,
  type: unknown,
  result: ParsedStreamEvent,
  id: string,
  context: ParseContext,
): void {
  const name = stringValue(item.name) ?? "mcp_tool";
  const args = objectValue(item.args);
  if ((type === "item.started" || item.status === "in_progress")) {
    result.toolActivity = { name, input: args, toolUseId: id || undefined };
    registerToolName(context, id, name);
    pushDisplay(result, { kind: "tool_use", id, name, input: JSON.stringify(args, null, 2), inputParsed: args });
  }
  if (type === "item.completed" || item.status === "completed" || item.status === "failed" || item.status === "error") {
    const resultText = stringValue(item.result);
    const failed = item.status === "failed" || item.status === "error";
    result.toolResult = { toolUseId: id, ...(resultText ? { agentResultText: resultText } : {}) };
    if (resultText || failed) {
      pushDisplay(result, { kind: "tool_result", toolName: name, toolUseId: id, output: resultText ?? "failed", isError: failed });
    }
  }
}

function handleCodexItem(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const type = obj.type;
  const item = objectValue(obj.item);
  const itemType = item.type;
  const id = stringValue(item.id) ?? "";
  if (itemType === "agent_message") {
    const text = stringValue(item.text);
    if (text) {
      result.assistantText = text;
      pushDisplay(result, { kind: "assistant", text, model: "codex" });
    }
  } else if (itemType === "reasoning") {
    const text = stringValue(item.text);
    if (text) pushDisplay(result, { kind: "thinking", text });
  } else if (itemType === "command_execution") {
    handleCodexCommandExecution(item, type, result, id, context);
  } else if (itemType === "mcp_tool_call") {
    handleCodexMcpToolCall(item, type, result, id, context);
  } else if (itemType === "file_change") {
    handleCodexFileChange(item, result, id);
  }
}

/**
 * Codex native `file_change` items: newer CLIs emit a `changes: [{path, kind}]`
 * array (kind = add|update|delete); older payloads carried a flat `path`.
 * Emitted as `file_change` tool_use display events so the summary layer can
 * classify them into filesEdited/filesWritten (#951 — these were previously
 * dropped by the offline summary parser entirely).
 */
function handleCodexFileChange(item: Record<string, unknown>, result: ParsedStreamEvent, id: string): void {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const entries = changes.length > 0
    ? changes.map((change) => objectValue(change)).map((change) => ({
      path: stringValue(change.path) ?? "",
      kind: stringValue(change.kind),
    }))
    : [{ path: stringValue(item.path) ?? "", kind: stringValue(item.kind) }];
  for (const entry of entries) {
    if (!entry.path) continue;
    pushDisplay(result, {
      kind: "tool_use",
      id,
      name: "file_change",
      input: entry.path,
      inputParsed: entry.kind ? { path: entry.path, kind: entry.kind } : { path: entry.path },
    });
  }
}

function hasCodexTokenFields(usage: Record<string, unknown>): boolean {
  return typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number";
}

function handleCodexTurnCompleted(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const usage = objectValue(obj.usage);
  const totalUsage = optionalObject(usage.total_token_usage) ?? usage;
  const currentUsage = optionalObject(usage.last_token_usage) ?? optionalObject(obj.last_token_usage) ?? usage;
  const inputTokens = numberValue(totalUsage.input_tokens);
  const outputTokens = numberValue(totalUsage.output_tokens);
  const contextTokens = numberValue(currentUsage.input_tokens) || inputTokens;
  // #976: when NONE of the expected usage shapes carry token fields, the
  // numberValue() defaults above read an upstream usage-shape change as a
  // silent "0 tokens". Record it through the rate-limited unknown-events path
  // so the drift is loud instead of misdiagnosed as an idle session.
  if (!hasCodexTokenFields(totalUsage) && !hasCodexTokenFields(currentUsage)) {
    recordUnknownAgentEvent("codex", "turn.completed#usage-shape-mismatch");
  }
  result.stats = {
    // The codex JSON stream carries no duration/cost — 0 means "not provided",
    // not a measured value.
    durationMs: 0,
    totalCostUsd: 0,
    inputTokens,
    outputTokens,
    contextTokens,
    numTurns: 1,
    model: "codex",
    success: true,
  };
  result.liveStats = { model: "", contextTokens };
  result.turnComplete = true;
  pushDisplay(result, {
    kind: "result",
    success: true,
    durationMs: 0,
    result: "",
    totalCostUsd: 0,
    inputTokens,
    outputTokens,
    model: "codex",
  });
}

export function parseCodexEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = obj.type;

  if (type === "thread.started") {
    const sessionId = stringValue(obj.thread_id);
    if (sessionId) {
      result.providerSessionId = sessionId;
      pushDisplay(result, { kind: "init", model: "codex", sessionId, cwd: "", tools: [], mcpServers: [], permissionMode: "" });
    }
  }

  handleCodexUsageLimit(obj, result);

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    handleCodexItem(obj, context, result);
  }

  if (type === "turn.completed") {
    handleCodexTurnCompleted(obj, result);
  } else if (type === "turn.failed") {
    const message = stringValue(objectValue(obj.error).message) ?? "Turn failed";
    pushDisplay(result, {
      kind: "result",
      success: false,
      durationMs: 0,
      result: message,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: "codex",
    });
  } else if (type === "error") {
    pushDisplay(result, { kind: "raw", text: stringValue(obj.message) ?? "Error" });
  }

  return hasFields(result) ? result : undefined;
}
