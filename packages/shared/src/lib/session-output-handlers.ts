export interface ParsedLine {
  type?: string;
  subtype?: string;
  data?: {
    content?: string | unknown[];
    reasoningText?: string;
    model?: string;
    toolCallId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    result?: { content?: string; detailedContent?: string } | string;
    success?: boolean;
  };
  message?: { content?: any[] };
  result?: string;
  is_error?: boolean;
  summary?: string;
  status?: string;
  rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number; overageStatus?: string; overageDisabledReason?: string; isUsingOverage?: boolean };
  item?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

/** A handler turns one parsed event into zero or more display lines. */
export type EventHandler = (obj: ParsedLine) => string[];

/** Last line of trimmed multi-line text ("" when empty). */
export function getLastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

/** Copilot: assistant.message events. */
export function handleAssistantMessage(obj: ParsedLine): string[] {
  const raw = obj.data?.content;
  const contentStr = typeof raw === "string" ? raw
    : Array.isArray(raw)
      ? (raw as { type?: string; text?: string }[])
          .filter(b => b.type === "text" && typeof b.text === "string")
          .map(b => b.text as string)
          .join("\n")
      : "";
  if (contentStr.trim()) {
    const text = getLastLine(contentStr);
    if (text) return [text.slice(0, 200)];
  } else if (obj.data?.reasoningText?.trim()) {
    // Use first line of reasoning as fallback when there is no direct content
    const text = (obj.data.reasoningText as string).trim().split("\n")[0] ?? "";
    if (text) return [text.slice(0, 200)];
  }
  return [];
}

export function handleToolExecutionStart(obj: ParsedLine): string[] {
  if (!obj.data?.toolName) return [];
  return [`[tool] ${obj.data.toolName}(${Object.keys(obj.data.arguments || {}).join(", ")})`];
}

export function handleToolExecutionComplete(obj: ParsedLine): string[] {
  if (obj.data?.success !== false) return [];
  const result = obj.data.result;
  const output = typeof result === "string" ? result : result?.content ?? result?.detailedContent ?? "";
  return [`[tool_error] ${obj.data.toolName || obj.data.toolCallId || "tool"}${output ? `: ${output.slice(0, 160)}` : ""}`];
}

/** Claude: assistant events with text and tool_use blocks. */
export function handleAssistant(obj: ParsedLine): string[] {
  if (!obj.message?.content) return [];
  const out: string[] = [];
  const content = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
  for (const block of content) {
    if (block.type === "text" && block.text?.trim()) {
      const text = getLastLine(block.text);
      if (text) out.push(text.slice(0, 200));
    }
    if (block.type === "tool_use") {
      out.push(`[tool] ${block.name}(${Object.keys(block.input || {}).join(", ")})`);
    }
  }
  return out;
}

export function handleResult(obj: ParsedLine): string[] {
  const resultText = typeof obj.result === "string" ? obj.result : obj.subtype ?? "";
  if (!resultText) return [];
  const trimmed = getLastLine(resultText);
  if (trimmed && trimmed !== "success") return [trimmed.slice(0, 200)];
  return [];
}

/** system events — only the task_notification subtype produces output. */
export function handleSystemEvent(obj: ParsedLine): string[] {
  if (obj.subtype !== "task_notification") return [];
  const summary = obj.summary || obj.status || "";
  return summary ? [`[task] ${summary}`] : [];
}

export function handleRateLimit(obj: ParsedLine): string[] {
  if (!obj.rate_limit_info) return [];
  const rli = obj.rate_limit_info;
  const parts = [`[rate_limit] ${rli.rateLimitType ?? "unknown"}: ${rli.status ?? "unknown"}`];
  if (rli.overageStatus === "rejected") parts.push("overage rejected");
  if (rli.resetsAt) parts.push(`resets ${new Date(rli.resetsAt * 1000).toISOString()}`);
  return [parts.join(" | ")];
}

/** Codex exec --json: item.completed / item.updated streaming events. */
export function handleItemEvent(obj: ParsedLine): string[] {
  const item = obj.item as Record<string, unknown> | undefined;
  if (!item) return [];
  const itemType = item.type as string | undefined;
  if (itemType === "agent_message") {
    const text = item.text as string | undefined;
    if (text?.trim()) {
      const lastLine = getLastLine(text);
      if (lastLine) return [lastLine.slice(0, 200)];
    }
  } else if (itemType === "command_execution") {
    const exitCode = item.exit_code as number | null | undefined;
    if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
      const output = item.aggregated_output as string | undefined;
      const cmd = item.command as string | undefined;
      return [`[tool_error] shell${cmd ? `(${cmd.slice(0, 60)})` : ""}${output ? `: ${output.slice(0, 120)}` : ""}`];
    }
  } else if (itemType === "mcp_tool_call") {
    const itemStatus = item.status as string | undefined;
    const toolName = item.name as string | undefined;
    if ((itemStatus === "failed" || itemStatus === "error") && toolName) {
      const result = item.result as string | undefined;
      return [`[tool_error] ${toolName}${result ? `: ${result.slice(0, 120)}` : ""}`];
    }
  }
  return [];
}

/** Codex exec --json: item.started streaming events. */
export function handleItemStarted(obj: ParsedLine): string[] {
  const item = obj.item as Record<string, unknown> | undefined;
  if (item && item.type === "command_execution") {
    const cmd = item.command as string | undefined;
    if (cmd) return [`[tool] shell(${cmd.slice(0, 160)})`];
  }
  return [];
}

export function handleTurnFailed(obj: ParsedLine): string[] {
  const error = obj.error as Record<string, unknown> | undefined;
  const msg = error?.message as string | undefined;
  return [`[error] ${msg ?? "Turn failed"}`];
}
