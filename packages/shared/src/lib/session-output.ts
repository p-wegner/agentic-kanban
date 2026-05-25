const NOISE_PATTERNS = [
  /"subtype"\s*:\s*"api_retry"/,
  /"type"\s*:\s*"system".*"subtype"\s*:\s*"init"/,
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[mGKH]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface ParsedLine {
  type?: string;
  subtype?: string;
  data?: {
<<<<<<< HEAD
    content?: string | unknown[];
=======
    content?: string;
>>>>>>> d97d029 (fix: add missing reasoningText to ParsedLine data type)
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

function parseJsonLine(line: string): ParsedLine | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractMeaningfulOutput(
  messages: { type: string; data: string | null }[],
  maxLines: number,
): string[] {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.type !== "stdout" || !msg.data) continue;

    const cleaned = stripAnsi(msg.data);

    for (const rawLine of cleaned.split("\n")) {
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) continue;

      if (NOISE_PATTERNS.some(p => p.test(trimmedLine))) continue;

      const obj = parseJsonLine(trimmedLine);

      if (obj) {
        if (obj.type === "assistant.message") {
          const raw = obj.data?.content;
          const contentStr = typeof raw === "string" ? raw
            : Array.isArray(raw)
              ? (raw as { type?: string; text?: string }[])
                  .filter(b => b.type === "text" && typeof b.text === "string")
                  .map(b => b.text as string)
                  .join("\n")
              : "";
          if (contentStr.trim()) {
            const text = contentStr.trim().split("\n").pop() ?? "";
            if (text) lines.push(text.slice(0, 200));
          } else if (obj.data?.reasoningText?.trim()) {
            // Use first line of reasoning as fallback when there is no direct content
            const text = (obj.data.reasoningText as string).trim().split("\n")[0] ?? "";
            if (text) lines.push(text.slice(0, 200));
          }
        }

        if (obj.type === "tool.execution_start" && obj.data?.toolName) {
          lines.push(`[tool] ${obj.data.toolName}(${Object.keys(obj.data.arguments || {}).join(", ")})`);
        }

        if (obj.type === "tool.execution_complete" && obj.data?.success === false) {
          const result = obj.data.result;
          const output = typeof result === "string" ? result : result?.content ?? result?.detailedContent ?? "";
          lines.push(`[tool_error] ${obj.data.toolName || obj.data.toolCallId || "tool"}${output ? `: ${output.slice(0, 160)}` : ""}`);
        }

        if (obj.type === "assistant" && obj.message?.content) {
          const content = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              const text = block.text.trim().split("\n").pop() ?? "";
              if (text) lines.push(text.slice(0, 200));
            }
            if (block.type === "tool_use") {
              lines.push(`[tool] ${block.name}(${Object.keys(block.input || {}).join(", ")})`);
            }
          }
        }

        if (obj.type === "result") {
          const resultText = typeof obj.result === "string" ? obj.result : obj.subtype ?? "";
          if (resultText) {
            const trimmed = resultText.trim().split("\n").pop() ?? "";
            if (trimmed && trimmed !== "success") lines.push(trimmed.slice(0, 200));
          }
        }

        if (obj.type === "system" && obj.subtype === "task_notification") {
          const summary = obj.summary || obj.status || "";
          if (summary) lines.push(`[task] ${summary}`);
        }

        if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
          const rli = obj.rate_limit_info;
          const parts = [`[rate_limit] ${rli.rateLimitType ?? "unknown"}: ${rli.status ?? "unknown"}`];
          if (rli.overageStatus === "rejected") parts.push("overage rejected");
          if (rli.resetsAt) parts.push(`resets ${new Date(rli.resetsAt * 1000).toISOString()}`);
          lines.push(parts.join(" | "));
        }

        // Codex exec --json streaming events
        if (obj.type === "item.completed" || obj.type === "item.updated") {
          const item = obj.item as Record<string, unknown> | undefined;
          if (item) {
            const itemType = item.type as string | undefined;
            if (itemType === "agent_message") {
              const text = item.text as string | undefined;
              if (text?.trim()) {
                const lastLine = text.trim().split("\n").pop() ?? "";
                if (lastLine) lines.push(lastLine.slice(0, 200));
              }
            } else if (itemType === "command_execution") {
              const exitCode = item.exit_code as number | null | undefined;
              if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
                const output = item.aggregated_output as string | undefined;
                const cmd = item.command as string | undefined;
                lines.push(`[tool_error] shell${cmd ? `(${cmd.slice(0, 60)})` : ""}${output ? `: ${output.slice(0, 120)}` : ""}`);
              }
            } else if (itemType === "mcp_tool_call") {
              const itemStatus = item.status as string | undefined;
              const toolName = item.name as string | undefined;
              if ((itemStatus === "failed" || itemStatus === "error") && toolName) {
                const result = item.result as string | undefined;
                lines.push(`[tool_error] ${toolName}${result ? `: ${result.slice(0, 120)}` : ""}`);
              }
            }
          }
        }

        if (obj.type === "item.started") {
          const item = obj.item as Record<string, unknown> | undefined;
          if (item && item.type === "command_execution") {
            const cmd = item.command as string | undefined;
            if (cmd) lines.push(`[tool] shell(${cmd.slice(0, 160)})`);
          }
        }

        if (obj.type === "turn.failed") {
          const error = obj.error as Record<string, unknown> | undefined;
          const msg = error?.message as string | undefined;
          lines.push(`[error] ${msg ?? "Turn failed"}`);
        }
      } else {
        if (trimmedLine.length > 2) {
          lines.push(trimmedLine.slice(0, 200));
        }
      }

      if (lines.length >= maxLines * 3) break;
    }

    if (lines.length >= maxLines * 3) break;
  }

  return lines.slice(0, maxLines);
}
