import {
  type EventHandler,
  type ParsedLine,
  handleAssistant,
  handleAssistantMessage,
  handleItemEvent,
  handleItemStarted,
  handleRateLimit,
  handleResult,
  handleSystemEvent,
  handleToolExecutionComplete,
  handleToolExecutionStart,
  handleTurnFailed,
} from "./session-output-handlers.js";

const NOISE_PATTERNS = [
  /"subtype"\s*:\s*"api_retry"/,
  /"type"\s*:\s*"system".*"subtype"\s*:\s*"init"/,
  /^CODEX_OK\s*$/, // Codex health-check probe
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[mGKH]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseJsonLine(line: string): ParsedLine | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Maps a parsed event's `type` to the handler that turns it into display lines. */
const EVENT_HANDLERS = new Map<string, EventHandler>([
  ["assistant.message", handleAssistantMessage],
  ["tool.execution_start", handleToolExecutionStart],
  ["tool.execution_complete", handleToolExecutionComplete],
  ["assistant", handleAssistant],
  ["result", handleResult],
  ["system", handleSystemEvent],
  ["rate_limit_event", handleRateLimit],
  // Codex exec --json streaming events
  ["item.completed", handleItemEvent],
  ["item.updated", handleItemEvent],
  ["item.started", handleItemStarted],
  ["turn.failed", handleTurnFailed],
]);

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
        const handler = obj.type ? EVENT_HANDLERS.get(obj.type) : undefined;
        if (handler) lines.push(...handler(obj));
      } else if (trimmedLine.length > 2) {
        lines.push(trimmedLine.slice(0, 200));
      }

      if (lines.length >= maxLines * 3) break;
    }

    if (lines.length >= maxLines * 3) break;
  }

  return lines.slice(0, maxLines);
}
