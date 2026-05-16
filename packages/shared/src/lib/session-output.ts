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
  message?: { content?: any[] };
  result?: string;
  is_error?: boolean;
  summary?: string;
  status?: string;
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
