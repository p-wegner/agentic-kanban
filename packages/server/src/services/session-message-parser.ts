/**
 * Pure helpers for extracting the last agent message from agent session
 * output (JSONL stream events). Handles the three event shapes the board
 * understands: Claude stream-json ("assistant"), the internal broadcast
 * shape ("assistant.message"), and Codex ("item.completed").
 */

import type { ParsedLine } from "@agentic-kanban/shared/lib/session-output-handlers";

const DEFAULT_MAX_LENGTH = 300;

/**
 * Parses a single JSONL line and returns the agent message text it carries,
 * or null when the line is empty, not JSON, or not an agent-message event.
 */
export function parseAgentMessageFromJsonLine(
  line: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as ParsedLine;
    let message: string | null = null;
    if (obj.type === "assistant" && obj.message?.content) {
      const content = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
      for (const block of [...content].reverse() as { type: string; text?: string }[]) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          message = block.text.trim().slice(0, maxLength);
          break;
        }
      }
    }
    if (obj.type === "assistant.message" && obj.data) {
      const data = obj.data;
      const raw = data.content;
      const contentStr = typeof raw === "string" ? raw
        : Array.isArray(raw)
          ? (raw as { type?: string; text?: string }[])
              .filter(b => b.type === "text" && typeof b.text === "string")
              .map(b => b.text as string)
              .join("\n")
          : "";
      if (contentStr.trim()) message = contentStr.trim().slice(0, maxLength);
    }
    const item = obj.item;
    if (obj.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      message = item.text.trim().slice(0, maxLength);
    }
    return message;
  } catch {
    return null; // not JSON
  }
}

/**
 * Scans JSONL lines in reverse (chronological input, latest first) and
 * returns the most recent agent message, or null when none is found.
 */
export function parseLastAgentMessage(
  lines: string[],
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const message = parseAgentMessageFromJsonLine(lines[i], maxLength);
    if (message) return message;
  }
  return null;
}
