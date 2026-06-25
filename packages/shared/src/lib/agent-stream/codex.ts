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

const CODEX_USAGE_LIMIT_PATTERN = /you(?:['\u2019])?ve hit your usage limit for\s+(.+?)(?:\.|$)/i;
const CODEX_RETRY_AFTER_PATTERN = /try again at\s+(.+?)(?:\.|$)/i;

function detectCodexUsageLimitText(text: string | undefined): { message: string; retryAfter?: string } | undefined {
  if (!text || !CODEX_USAGE_LIMIT_PATTERN.test(text)) return undefined;
  return { message: text.trim(), retryAfter: CODEX_RETRY_AFTER_PATTERN.exec(text)?.[1]?.trim() };
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

  const error = objectValue(obj.error);
  const usageLimit = detectCodexUsageLimitText(stringValue(obj.message) ?? stringValue(error.message));
  if (usageLimit) {
    result.rateLimitInfo = {
      status: "limited",
      rateLimitType: "usage_limit",
      retryAfter: usageLimit.retryAfter,
      message: usageLimit.message,
    };
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
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
      const command = stringValue(item.command) ?? "";
      if ((type === "item.started" || item.status === "in_progress") && command) {
        result.toolActivity = { name: "shell", input: { command }, toolUseId: id || undefined };
        registerToolName(context, id, "shell_command");
        pushDisplay(result, { kind: "tool_use", id, name: "shell_command", input: command, inputParsed: { command } });
      }
      if (type === "item.completed" || item.status === "completed") {
        const output = stringValue(item.aggregated_output) ?? "";
        result.toolResult = { toolUseId: id };
        if (output) {
          pushDisplay(result, {
            kind: "tool_result",
            toolName: "shell_command",
            toolUseId: id,
            output,
            isError: item.exit_code !== null && item.exit_code !== 0,
          });
        }
      }
    } else if (itemType === "mcp_tool_call") {
      const name = stringValue(item.name) ?? "mcp_tool";
      const args = objectValue(item.args);
      if ((type === "item.started" || item.status === "in_progress")) {
        result.toolActivity = { name, input: args, toolUseId: id || undefined };
        registerToolName(context, id, name);
        pushDisplay(result, { kind: "tool_use", id, name, input: JSON.stringify(args, null, 2), inputParsed: args });
      }
      if (type === "item.completed" || item.status === "completed") {
        const resultText = stringValue(item.result);
        result.toolResult = { toolUseId: id, ...(resultText ? { agentResultText: resultText } : {}) };
        if (resultText) {
          pushDisplay(result, { kind: "tool_result", toolName: name, toolUseId: id, output: resultText, isError: false });
        }
      }
    } else if (itemType === "file_change") {
      const path = stringValue(item.path) ?? "";
      pushDisplay(result, { kind: "tool_use", id, name: "file_change", input: path, inputParsed: { path } });
    }
  }

  if (type === "turn.completed") {
    const usage = objectValue(obj.usage);
    const totalUsage = optionalObject(usage.total_token_usage) ?? usage;
    const currentUsage = optionalObject(usage.last_token_usage) ?? optionalObject(obj.last_token_usage) ?? usage;
    const inputTokens = numberValue(totalUsage.input_tokens);
    const outputTokens = numberValue(totalUsage.output_tokens);
    const contextTokens = numberValue(currentUsage.input_tokens) || inputTokens;
    result.stats = {
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
  } else if (type === "turn.failed") {
    const message = stringValue(error.message) ?? "Turn failed";
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
