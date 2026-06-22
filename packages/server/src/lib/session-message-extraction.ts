// Pure string-parsing helpers for agent session output (JSONL stdout) and
// JSON-encoded DB columns. No dependencies on the database or other services.

import type { ParsedLine } from "@agentic-kanban/shared/lib/session-output-handlers";

export function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function extractAssistantMessage(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "assistant") {
        const content = (obj.message as { content?: unknown[] })?.content ?? [];
        for (const block of [...content].reverse() as { type: string; text?: string }[]) {
          if (block.type === "text" && block.text?.trim()) return block.text.trim();
        }
      }
      if (obj.type === "assistant.message") {
        const messageData = obj.data as Record<string, unknown> | undefined;
        const raw = messageData?.content;
        const contentStr = typeof raw === "string" ? raw
          : Array.isArray(raw)
            ? (raw as { type?: string; text?: string }[])
                .filter(b => b.type === "text" && typeof b.text === "string")
                .map(b => b.text as string)
                .join("\n")
            : "";
        if (contentStr.trim()) return contentStr.trim();
      }
      if (
        obj.type === "item.completed"
        && (obj.item as { type?: string; text?: string } | undefined)?.type === "agent_message"
      ) {
        const text = (obj.item as { text?: string }).text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}

export function extractToolName(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type !== "assistant") continue;
      const content = (obj.message as { content?: unknown[] })?.content ?? [];
      for (const block of content as { type: string; name?: string }[]) {
        if (block.type === "tool_use" && block.name) return block.name;
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}

/**
 * Scan ordered session message rows (newest-first as the CLI passes them) and
 * return the last agent text it can find, stopping at the first row that yields
 * one. Handles the three provider stream shapes (assistant / assistant.message /
 * item.completed). NOTE: this intentionally differs from extractAssistantMessage
 * (which takes one string and returns on the first matching line) — it scans
 * multiple rows and, per assistant block, keeps the first original-order text
 * block; preserved verbatim from the `issue status` handler it was lifted from.
 */
export function extractLastAgentMessageFromRows(
  rows: Array<{ type: string | null; data: string | null }>,
): string | null {
  let lastAgentMsg: string | null = null;
  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;
    const lines = row.data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as ParsedLine;
        if (obj.type === "assistant") {
          const content = obj.message?.content;
          if (content) {
            for (const block of [...content].reverse()) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                lastAgentMsg = block.text;
              }
            }
          }
        }
        if (obj.type === "assistant.message") {
          const data = obj.data;
          if (data) {
            const raw = data.content;
            const contentStr = typeof raw === "string" ? raw
              : Array.isArray(raw)
                ? (raw as { type?: string; text?: string }[])
                    .filter(b => b.type === "text" && typeof b.text === "string")
                    .map(b => b.text as string)
                    .join("\n")
                : "";
            if (contentStr.trim()) lastAgentMsg = contentStr;
          }
        }
        const item = obj.item;
        if (obj.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          lastAgentMsg = item.text;
        }
      } catch { /* not JSON */ }
    }
    if (lastAgentMsg) break;
  }
  return lastAgentMsg;
}
