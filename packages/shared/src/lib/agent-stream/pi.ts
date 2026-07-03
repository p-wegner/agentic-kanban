import type { ParseContext, ParsedStreamEvent } from "./types.js";
import {
  contentToText,
  hasFields,
  numberValue,
  objectValue,
  pushDisplay,
  registerToolName,
  stringValue,
  stringifyValue,
  toolNameFor,
} from "./shared.js";
import { recordUnknownFieldDrift } from "./unknown-fields.js";
import { piUsageLacksTokenFields, piUsageSchema } from "./pi-schema.js";

function extractPiUsage(message: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  totalCostUsd: number;
} {
  const usage = objectValue(message.usage);
  const cost = objectValue(usage.cost);
  const inputTokens = numberValue(usage.input);
  const outputTokens = numberValue(usage.output);
  return {
    inputTokens,
    outputTokens,
    contextTokens: inputTokens + numberValue(usage.cacheRead),
    totalCostUsd: numberValue(cost.total),
  };
}

function extractPiContentText(content: unknown): string | undefined {
  const text = contentToText(content);
  return text || undefined;
}

function handlePiSession(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const sessionId = stringValue(obj.id) ?? "";
  if (sessionId) result.providerSessionId = sessionId;
  pushDisplay(result, {
    kind: "init",
    model: context.model ?? "pi",
    sessionId,
    cwd: stringValue(obj.cwd) ?? "",
    tools: [],
    mcpServers: [],
    permissionMode: "",
  });
}

function handlePiMessageUpdate(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const message = objectValue(obj.message);
  const assistantEvent = objectValue(obj.assistantMessageEvent);
  const eventType = assistantEvent.type;
  const msgModel = stringValue(message.model);
  if (msgModel) context.model = msgModel;
  if (eventType === "text_delta" && typeof assistantEvent.delta === "string") {
    result.assistantText = assistantEvent.delta;
    pushDisplay(result, { kind: "assistant", text: assistantEvent.delta, model: msgModel || context.model || "pi" });
  } else if (eventType === "text_start" || eventType === "text_end") {
    const text = stringValue(assistantEvent.content);
    if (text) result.assistantText = text;
  } else if (eventType === "toolcall_start" || eventType === "toolcall_end") {
    let toolCall = objectValue(assistantEvent.toolCall);
    if (Object.keys(toolCall).length === 0) {
      const partialContent = objectValue(assistantEvent.partial).content;
      if (Array.isArray(partialContent)) toolCall = objectValue(partialContent[0]);
    }
    const name = stringValue(toolCall.name);
    if (name) result.toolActivity = { name, input: objectValue(toolCall.arguments), toolUseId: stringValue(toolCall.id) };
  }
}

function handlePiToolExecutionStart(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const id = stringValue(obj.toolCallId) ?? "";
  const name = stringValue(obj.toolName) ?? "pi_tool";
  const input = objectValue(obj.args);
  result.toolActivity = { name, input, toolUseId: id || undefined };
  registerToolName(context, id, name);
  pushDisplay(result, { kind: "tool_use", id, name, input: stringifyValue(obj.args), inputParsed: input });
}

function handlePiToolExecutionEnd(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const id = stringValue(obj.toolCallId) ?? "";
  const output = extractPiContentText(objectValue(obj.result).content) ?? stringifyValue(obj.result);
  result.toolResult = { toolUseId: id, ...(output ? { agentResultText: output } : {}) };
  pushDisplay(result, {
    kind: "tool_result",
    toolName: stringValue(obj.toolName) ?? toolNameFor(context, id, "pi_tool"),
    toolUseId: id,
    output,
    isError: obj.isError === true,
  });
}

function handlePiMessageBoundary(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const message = objectValue(obj.message);
  if (message.model) context.model = stringValue(message.model);
  if (message.role === "toolResult") {
    const id = stringValue(message.toolCallId);
    if (id) result.toolResult = { toolUseId: id, ...(extractPiContentText(message.content) ? { agentResultText: extractPiContentText(message.content) } : {}) };
  } else if (message.role === "assistant") {
    const text = extractPiContentText(message.content);
    if (text) result.assistantText = text;
  }
  if (message.stopReason === "error") {
    const errorMessage = stringValue(message.errorMessage) ?? "Pi turn failed";
    const signature = `${stringValue(message.model) || context.model || "pi"}:${errorMessage}`;
    if (signature !== context.lastErrorSignature) {
      context.lastErrorSignature = signature;
      const usage = extractPiUsage(message);
      pushDisplay(result, {
        kind: "result",
        success: false,
        durationMs: 0,
        result: errorMessage,
        totalCostUsd: usage.totalCostUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: stringValue(message.model) || context.model || "pi",
      });
    }
  }
}

function handlePiLiveStats(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const message = objectValue(obj.message);
  if (Object.keys(message).length === 0) return;
  const usage = extractPiUsage(message);
  const model = stringValue(message.model) ?? "";
  if (model || usage.contextTokens > 0) result.liveStats = { model, contextTokens: usage.contextTokens };
}

function handlePiTurnEnd(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const message = objectValue(obj.message);
  const usageMessage = Object.keys(message).length > 0 ? message : objectValue(obj.message);
  const usage = extractPiUsage(usageMessage);
  // #994: neither `input` nor `output` present on the usage object means the
  // numberValue() defaults in extractPiUsage() silently read an upstream
  // rename as "0 tokens" (the same failure class as the codex #976 fix).
  const rawUsage = objectValue(usageMessage.usage);
  if (piUsageLacksTokenFields(rawUsage)) {
    const parsed = piUsageSchema.safeParse(rawUsage);
    const detail = parsed.success
      ? "usage object matched the schema but carried no known token fields"
      : parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    recordUnknownFieldDrift("pi", "turn_end", detail);
  }
  result.stats = {
    durationMs: 0,
    totalCostUsd: usage.totalCostUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens: usage.contextTokens,
    numTurns: 1,
    model: stringValue(usageMessage.model) ?? "",
    success: usageMessage.stopReason !== "error",
    agentSummary: extractPiContentText(usageMessage.content),
  };
  result.turnComplete = true;
  if (usageMessage.stopReason === "error") {
    const errorMessage = stringValue(usageMessage.errorMessage);
    if (errorMessage && /rate.?limit|usage.?limit|quota/i.test(errorMessage)) {
      result.rateLimitInfo = { status: "limited", rateLimitType: "usage_limit", message: errorMessage };
    }
  }
}

function handlePiAgentEnd(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  const lastAssistant = [...messages].reverse()
    .map((entry) => objectValue(entry))
    .find((entry) => entry.role === "assistant");
  if (!lastAssistant) return;
  if (lastAssistant.model) context.model = stringValue(lastAssistant.model);
  const resultText = lastAssistant.stopReason === "error" ? stringValue(lastAssistant.errorMessage) ?? "Pi turn failed" : "";
  const signature = `${stringValue(lastAssistant.model) || context.model || "pi"}:${resultText}`;
  if (lastAssistant.stopReason !== "error" || signature !== context.lastErrorSignature) {
    if (lastAssistant.stopReason === "error") context.lastErrorSignature = signature;
    const usage = extractPiUsage(lastAssistant);
    pushDisplay(result, {
      kind: "result",
      success: lastAssistant.stopReason !== "error",
      durationMs: 0,
      result: resultText,
      totalCostUsd: usage.totalCostUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: stringValue(lastAssistant.model) || context.model || "pi",
    });
  }
}

function handlePiRateLimit(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const info = objectValue(obj.rate_limit_info ?? obj.rateLimitInfo ?? obj);
  result.rateLimitInfo = {
    status: stringValue(info.status) ?? "limited",
    rateLimitType: stringValue(info.rateLimitType ?? info.rate_limit_type) ?? "usage_limit",
    resetsAt: numberValue(info.resetsAt ?? info.resets_at) || undefined,
    retryAfter: stringValue(info.retryAfter ?? info.retry_after),
    message: stringValue(info.message),
    overageStatus: stringValue(info.overageStatus),
    overageDisabledReason: stringValue(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
  };
}

export function parsePiEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = stringValue(obj.type);

  if (type === "session") handlePiSession(obj, context, result);
  if (type === "message_update") handlePiMessageUpdate(obj, context, result);
  if (type === "tool_execution_start") handlePiToolExecutionStart(obj, context, result);
  if (type === "tool_execution_end") handlePiToolExecutionEnd(obj, context, result);
  if (type === "message_start" || type === "message_end") handlePiMessageBoundary(obj, context, result);
  if (type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end") {
    handlePiLiveStats(obj, result);
  }
  if (type === "turn_end") handlePiTurnEnd(obj, result);
  if (type === "agent_end") handlePiAgentEnd(obj, context, result);
  if (type === "rate_limit_event" || type === "rate_limit") handlePiRateLimit(obj, result);
  if (type === "error") pushDisplay(result, { kind: "raw", text: stringValue(obj.message) ?? JSON.stringify(obj) });

  return hasFields(result) ? result : undefined;
}
