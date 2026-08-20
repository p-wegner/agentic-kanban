import type { ParseContext, ParsedStreamEvent } from "./types.js";
import {
  getStringArray,
  hasFields,
  numberValue,
  objectValue,
  pushDisplay,
  registerToolName,
  stringValue,
  toolNameFor,
} from "./shared.js";
import { recordUnknownFieldDrift } from "./unknown-fields.js";
import {
  claudeAssistantContentShapeDrifted,
  claudeAssistantMessageSchema,
  claudeAssistantUsageLacksTokenFields,
  claudeResultLacksTokenFields,
  claudeResultUsageSchema,
  claudeSystemInitSchema,
  describeClaudeDrift,
} from "./claude-schema.js";

function handleClaudeSystemInit(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const sessionId = stringValue(obj.session_id) ?? "";
  if (sessionId) {
    result.providerSessionId = sessionId;
  } else {
    // FAIL LOUD (arch-review §2.2): a system/init event that should carry
    // session_id but doesn't (a rename/drift) reads identically to "no session
    // id yet" under stringValue coercion and silently breaks the resume chain.
    // Surface it via telemetry + a logged warning; still emit the init display
    // event so the parser degrades observably rather than crashing.
    const parsed = claudeSystemInitSchema.safeParse(obj);
    const detail = describeClaudeDrift(parsed, "session_id parsed but was empty");
    recordUnknownFieldDrift(
      "claude",
      "system.init",
      `missing session_id — resume chain will break (${detail})`,
    );
  }
  pushDisplay(result, {
    kind: "init",
    model: stringValue(obj.model) ?? "unknown",
    sessionId,
    cwd: stringValue(obj.cwd) ?? "",
    tools: getStringArray(obj.tools),
    mcpServers: Array.isArray(obj.mcp_servers) ? obj.mcp_servers as { name: string; status: string }[] : [],
    permissionMode: stringValue(obj.permissionMode) ?? "",
  });
}

function handleSystemEvent(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const subtype = obj.subtype;
  if (subtype === "init") {
    handleClaudeSystemInit(obj, result);
  } else if (subtype === "task_started") {
    pushDisplay(result, {
      kind: "task_started",
      taskId: stringValue(obj.task_id) ?? "",
      toolUseId: stringValue(obj.tool_use_id) ?? "",
      description: stringValue(obj.description) ?? "",
      taskType: stringValue(obj.task_type) ?? "",
    });
  } else if (subtype === "notification") {
    pushDisplay(result, {
      kind: "notification",
      key: stringValue(obj.key) ?? "",
      text: stringValue(obj.text) ?? "",
      priority: stringValue(obj.priority) ?? "",
    });
  } else if (subtype === "status") {
    const text = stringValue(obj.status) ?? stringValue(obj.message);
    if (text) pushDisplay(result, { kind: "raw", text: `[status] ${text}` });
  } else if (subtype === "task_progress") {
    const usage = objectValue(obj.usage);
    const toolUses = numberValue(usage.tool_uses);
    if (toolUses) result.liveStats = { model: "", contextTokens: 0, toolUses };
    const text = stringValue(obj.message) ?? stringValue(obj.progress);
    if (text) pushDisplay(result, { kind: "raw", text: `[progress] ${text}` });
  }
}

function handleClaudeToolUseBlock(block: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const id = stringValue(block.id) ?? "";
  const name = stringValue(block.name) ?? "unknown";
  const input = objectValue(block.input);
  registerToolName(context, id, name);
  if (!result.toolActivity) result.toolActivity = { name, input, toolUseId: id || undefined };
  pushDisplay(result, { kind: "tool_use", id, name, input: JSON.stringify(block.input, null, 2), inputParsed: input });
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    result.todos = (input.todos as Array<{ subject: string; status: string }>).map((t) => ({ subject: t.subject, status: t.status }));
  }
  if (name === "Agent") {
    result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens: 0 }), subagentDelta: 1 };
  }
}

function handleAssistantEvent(
  obj: Record<string, unknown>,
  context: ParseContext,
  result: ParsedStreamEvent,
  isSubagentMessage: boolean,
): void {
  const message = objectValue(obj.message);
  const usage = objectValue(message.usage);
  const model = stringValue(message.model) ?? "";
  const contextTokens = numberValue(usage.cache_read_input_tokens) + numberValue(usage.input_tokens);
  if (!isSubagentMessage && (model || contextTokens > 0)) {
    result.liveStats = { model, contextTokens };
  }

  // arch-review §2.2: two inner-field drift sites. A PRESENT-but-renamed
  // `message.usage` reads contextTokens as a silent 0 (claude.ts:84 was the
  // #976/#994 "0 tokens" class); a `message.content` that is no longer an array
  // silently drops assistantText (claude.ts:89) → hadSubstantiveOutput false →
  // completed runs misclassified as launch failures. Report both as field drift
  // instead of degrading silently. Subagent messages are excluded (they don't
  // feed the main liveStats/hadSubstantiveOutput signal).
  if (!isSubagentMessage) {
    if (claudeAssistantUsageLacksTokenFields(message)) {
      const parsed = claudeAssistantMessageSchema.safeParse(message);
      const detail = describeClaudeDrift(parsed, "usage object present but carried no known token fields");
      recordUnknownFieldDrift("claude", "assistant#usage", detail);
    }
    if (claudeAssistantContentShapeDrifted(message)) {
      const parsed = claudeAssistantMessageSchema.safeParse(message);
      const detail = describeClaudeDrift(parsed, "content matched the schema but was not the expected block array");
      recordUnknownFieldDrift("claude", "assistant#content", detail);
    }
  }

  const content = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
  const textParts: string[] = [];
  for (const block of content) {
    const blockType = block.type;
    if (blockType === "thinking") {
      const text = stringValue(block.thinking);
      if (text) pushDisplay(result, { kind: "thinking", text });
    } else if (blockType === "text") {
      const text = stringValue(block.text);
      if (text) {
        textParts.push(text);
        pushDisplay(result, { kind: "assistant", text, model });
      }
    } else if (blockType === "image") {
      const source = objectValue(block.source);
      if (source.type === "base64" && typeof source.data === "string") {
        pushDisplay(result, { kind: "image", mediaType: stringValue(source.media_type) ?? "image/png", data: source.data });
      }
    } else if (blockType === "tool_use") {
      handleClaudeToolUseBlock(block, context, result);
    }
  }
  if (textParts.length > 0) result.assistantText = textParts.join("\n");
}

function handleUserEvent(obj: Record<string, unknown>, context: ParseContext, result: ParsedStreamEvent): void {
  const content = Array.isArray(objectValue(obj.message).content)
    ? objectValue(obj.message).content as Record<string, unknown>[]
    : [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const toolUseId = stringValue(block.tool_use_id) ?? "";
    const images: Array<{ mediaType: string; data: string }> = [];
    let output = "";
    if (typeof block.content === "string") {
      output = block.content;
    } else if (Array.isArray(block.content)) {
      const textParts: string[] = [];
      for (const inner of block.content as Record<string, unknown>[]) {
        if (inner.type === "text" && typeof inner.text === "string") textParts.push(inner.text);
        const source = objectValue(inner.source);
        if (inner.type === "image" && source.type === "base64" && typeof source.data === "string") {
          images.push({ mediaType: stringValue(source.media_type) ?? "image/png", data: source.data });
        }
      }
      output = textParts.length > 0 ? textParts.join("\n") : images.length > 0 ? "" : JSON.stringify(block.content);
    } else {
      output = JSON.stringify(block.content);
    }
    result.toolResult = {
      toolUseId,
      ...(images.length > 0 ? { images } : {}),
      ...(output ? { agentResultText: output } : {}),
    };
    pushDisplay(result, {
      kind: "tool_result",
      toolName: toolNameFor(context, toolUseId, toolUseId ? `tool_${toolUseId}` : "unknown"),
      toolUseId,
      output,
      isError: block.is_error === true,
      ...(images.length > 0 ? { images } : {}),
    });
  }
}

function handleRateLimitEvent(obj: Record<string, unknown>, result: ParsedStreamEvent): void {
  const info = objectValue(obj.rate_limit_info);
  result.rateLimitInfo = {
    status: stringValue(info.status) ?? "",
    rateLimitType: stringValue(info.rateLimitType) ?? "",
    resetsAt: numberValue(info.resetsAt) || undefined,
    overageStatus: stringValue(info.overageStatus),
    overageDisabledReason: stringValue(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
  };
  pushDisplay(result, {
    kind: "rate_limit",
    status: result.rateLimitInfo.status,
    resetsAt: result.rateLimitInfo.resetsAt ?? 0,
    rateLimitType: result.rateLimitInfo.rateLimitType,
    overageStatus: result.rateLimitInfo.overageStatus,
    overageDisabledReason: result.rateLimitInfo.overageDisabledReason,
    isUsingOverage: result.rateLimitInfo.isUsingOverage,
  });
}

function handleResultEvent(obj: Record<string, unknown>, result: ParsedStreamEvent, isSubagentMessage: boolean): void {
  const usage = objectValue(obj.usage);
  const modelUsage = objectValue(obj.modelUsage);
  const firstModelEntry = Object.keys(modelUsage).length > 0
    ? Object.entries(modelUsage)[0] as [string, Record<string, unknown>]
    : undefined;
  const firstModelUsage = firstModelEntry?.[1];
  const rawCost = obj.total_cost_usd ?? obj.cost_usd;
  const inputTokens = numberValue(firstModelUsage?.inputTokens ?? usage.input_tokens);
  const outputTokens = numberValue(firstModelUsage?.outputTokens ?? usage.output_tokens);
  const model = firstModelEntry?.[0] ?? stringValue(obj.model) ?? "";
  // #994: neither the flat `usage` nor any `modelUsage` entry carrying a token
  // field means the numberValue() defaults above silently read an upstream
  // rename as "0 tokens" (the same failure class as the codex #976 fix).
  if (!isSubagentMessage && claudeResultLacksTokenFields(obj)) {
    const parsed = claudeResultUsageSchema.safeParse(obj);
    const detail = parsed.success
      ? "usage/modelUsage matched the schema but carried no known token fields"
      : parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    recordUnknownFieldDrift("claude", "result", detail);
  }
  if (!isSubagentMessage) {
    result.stats = {
      durationMs: numberValue(obj.duration_ms),
      totalCostUsd: numberValue(rawCost),
      inputTokens,
      outputTokens,
      numTurns: numberValue(obj.num_turns) || 1,
      model,
      success: obj.subtype === "success" && !obj.is_error,
      agentSummary: stringValue(obj.result),
    };
    result.turnComplete = true;
    pushDisplay(result, {
      kind: "result",
      success: result.stats.success,
      durationMs: result.stats.durationMs,
      result: result.stats.agentSummary ?? "",
      totalCostUsd: result.stats.totalCostUsd,
      inputTokens,
      outputTokens,
      model,
    });
  }
  const contextTokens = numberValue(usage.cache_read_input_tokens) + numberValue(usage.input_tokens);
  if (!isSubagentMessage && contextTokens > 0) {
    result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens }), contextTokens };
  }
  const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials as Array<Record<string, unknown>> : [];
  if (denials.some((d) => d.tool_name === "ExitPlanMode")) result.exitPlanModeDenied = true;
}

// Top-level event types this parser understands. A known type that yields no
// fields (e.g. a plain text-only `user` message — no tool_result blocks) is a
// HEALTHY event, not wire-format drift: return an empty-but-defined result so
// the unknown-event drift detector never counts it (#969). Only types outside
// this set fall through to `undefined` and get flagged as unknown.
const KNOWN_CLAUDE_EVENT_TYPES = new Set(["system", "assistant", "user", "rate_limit_event", "result"]);

export function parseClaudeEvent(obj: Record<string, unknown>, context: ParseContext): ParsedStreamEvent | undefined {
  const result: ParsedStreamEvent = {};
  const type = obj.type;
  const isSubagentMessage = obj.parent_tool_use_id != null;

  if (type === "system") handleSystemEvent(obj, result);
  if (type === "assistant") handleAssistantEvent(obj, context, result, isSubagentMessage);
  if (type === "user") handleUserEvent(obj, context, result);
  if (type === "rate_limit_event") handleRateLimitEvent(obj, result);
  if (type === "result") handleResultEvent(obj, result, isSubagentMessage);

  if (hasFields(result)) return result;
  // Known-but-fieldless: recognized-but-empty (#969), unknown types: undefined.
  return typeof type === "string" && KNOWN_CLAUDE_EVENT_TYPES.has(type) ? result : undefined;
}
