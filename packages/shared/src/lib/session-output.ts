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
    content?: string;
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
        if (obj.type === "assistant.message" && obj.data?.content?.trim()) {
          const text = obj.data.content.trim().split("\n").pop() ?? "";
          if (text) lines.push(text.slice(0, 200));
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
