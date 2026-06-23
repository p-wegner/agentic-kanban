// Pure string-parsing helpers for agent session output (JSONL stdout) and
// JSON-encoded DB columns. No dependencies on the database or other services.

import {
  createAgentStreamExtractionContext,
  extractAssistantTextsFromLine,
  extractFirstToolNameFromLine,
} from "./agent-stream-extraction.js";

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
  const context = createAgentStreamExtractionContext();
  for (const line of data.split("\n")) {
    const texts = extractAssistantTextsFromLine(line, context);
    const text = texts.at(-1)?.trim();
    if (text) return text;
  }
  return null;
}

export function extractToolName(data: string): string | null {
  const context = createAgentStreamExtractionContext();
  for (const line of data.split("\n")) {
    const name = extractFirstToolNameFromLine(line, context);
    if (name) return name;
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
  const context = createAgentStreamExtractionContext();
  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;
    const lines = row.data.split("\n");
    for (const line of lines) {
      const texts = extractAssistantTextsFromLine(line, context);
      if (texts.length > 0) lastAgentMsg = texts[0];
    }
    if (lastAgentMsg) break;
  }
  return lastAgentMsg;
}
