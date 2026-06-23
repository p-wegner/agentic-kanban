import {
  createAgentStreamExtractionContext,
  extractAssistantTextsFromLine,
} from "../lib/agent-stream-extraction.js";

const DEFAULT_MAX_LENGTH = 300;

/**
 * Parses a single JSONL line and returns the agent message text it carries,
 * or null when the line is empty, not JSON, or not an agent-message event.
 */
export function parseAgentMessageFromJsonLine(
  line: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  const messages = extractAssistantTextsFromLine(line);
  const message = messages.at(-1)?.trim();
  return message ? message.slice(0, maxLength) : null;
}

/**
 * Scans JSONL lines in reverse (chronological input, latest first) and
 * returns the most recent agent message, or null when none is found.
 */
export function parseLastAgentMessage(
  lines: string[],
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  const context = createAgentStreamExtractionContext();
  for (let i = lines.length - 1; i >= 0; i--) {
    const messages = extractAssistantTextsFromLine(lines[i], context);
    const message = messages.at(-1)?.trim();
    if (message) return message.slice(0, maxLength);
  }
  return null;
}
