import type { AgentOutputMessage } from "@agentic-kanban/shared";

export interface ClaudeUsageLimitInfo {
  message: string;
  /** ISO string of when the limit resets, if we can recover it (Claude reports unix epoch seconds). */
  resetsAt: string | null;
}

/**
 * Claude Code surfaces a subscription (Max/Pro plan) quota exhaustion as a message
 * like "Claude usage limit reached. Your limit will reset at 3pm." or, in the
 * stream-json output, a `rate_limit_event` whose status is `allowed_warning` /
 * `rejected` with a `resetsAt` epoch. We match the human-readable text and the
 * structured event so a subscription that hits its cap can be rotated, mirroring
 * the Codex usage-limit handling (codex-rate-limit.ts).
 */
export const CLAUDE_USAGE_LIMIT_PATTERN =
  /claude (?:ai )?usage limit reached|(?:5-hour|weekly|session) limit reached|usage limit[^\n]{0,80}reset/i;
const RESET_AT_PATTERN = /reset(?:s)?\s+at\s+(.+?)(?:\.|$)/i;

/** Structured rate-limit statuses that mean the subscription genuinely can't continue. */
const BLOCKING_RATE_LIMIT_STATUSES = new Set(["rejected", "blocked", "exhausted"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Convert a Claude rate_limit_event `resetsAt` (unix epoch seconds) to an ISO string. */
function resetsAtToIso(resetsAt: unknown): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  return new Date(ms).toISOString();
}

export function detectClaudeUsageLimitText(text: string | null | undefined): ClaudeUsageLimitInfo | null {
  if (!text || !CLAUDE_USAGE_LIMIT_PATTERN.test(text)) return null;
  const resetsAt = RESET_AT_PATTERN.exec(text)?.[1]?.trim() || null;
  return { message: text.trim(), resetsAt };
}

/**
 * Line-level text/structured detection, EXCLUDING `rate_limit_event` handling (that is
 * resolved once, authoritatively, across the whole message batch by the caller).
 *
 * A stream-json line for a tool result (`type: "user"`, carrying `tool_result` blocks) can
 * embed an entire file's contents with newlines escaped as literal `\n` - e.g. a Read of this
 * very source file. Matching text patterns against such a line lets "usage limit" and "reset"
 * from unrelated parts of the file satisfy the pattern, so those lines are never text-matched.
 * Only plain (non-JSON) text, and the narrow structured fields below, can carry a real notice.
 */
function detectClaudeUsageLimitLine(line: string): ClaudeUsageLimitInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(trimmed) as unknown);
  } catch {
    record = null;
  }

  // Not JSON: genuine plain-text stdout (e.g. a CLI banner), safe to match directly.
  if (record === null) return detectClaudeUsageLimitText(trimmed);

  // Handled separately (authoritative), and tool-result/tool-input payloads can carry
  // arbitrary file content - never text-match either.
  if (record.type === "rate_limit_event" || record.type === "user" || record.type === "tool_result") return null;

  if (typeof record.message === "string") {
    const info = detectClaudeUsageLimitText(record.message);
    if (info) return info;
  }

  const error = asRecord(record.error);
  if (typeof error?.message === "string") {
    const info = detectClaudeUsageLimitText(error.message);
    if (info) return info;
  }

  // Claude's `result` event carries a `result` string on error turns.
  if (typeof record.result === "string") {
    const info = detectClaudeUsageLimitText(record.result);
    if (info) return info;
  }

  // Assistant text blocks (`message.content[].type === "text"`) - bounded prose, safe.
  const message = asRecord(record.message);
  if (Array.isArray(message?.content)) {
    for (const block of message.content as unknown[]) {
      const blockRecord = asRecord(block);
      if (blockRecord?.type === "text" && typeof blockRecord.text === "string") {
        const info = detectClaudeUsageLimitText(blockRecord.text);
        if (info) return info;
      }
    }
  }

  return null;
}

/** Scan every line of every message for a `rate_limit_event`; the LAST one seen wins. */
function findLastRateLimitEvent(messages: AgentOutputMessage[]): { status: string; resetsAt: unknown } | null {
  let last: { status: string; resetsAt: unknown } | null = null;
  for (const message of messages) {
    if (!message.data) continue;
    for (const line of message.data.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = asRecord(JSON.parse(trimmed) as unknown);
        if (record?.type !== "rate_limit_event") continue;
        const info = asRecord(record.rate_limit_info);
        last = { status: typeof info?.status === "string" ? info.status : "", resetsAt: info?.resetsAt };
      } catch {
        // not JSON, or not a rate_limit_event line
      }
    }
  }
  return last;
}

export function detectClaudeUsageLimitMessages(messages: AgentOutputMessage[]): ClaudeUsageLimitInfo | null {
  // The structured `rate_limit_event` is authoritative when present. It reflects Claude's own
  // accounting (`status: "allowed" | "rejected" | ...`) and must never be overridden by a text
  // heuristic false-positive elsewhere in the same batch (see module doc comment / #488).
  const lastEvent = findLastRateLimitEvent(messages);
  if (lastEvent) {
    if (!BLOCKING_RATE_LIMIT_STATUSES.has(lastEvent.status)) return null;
    return {
      message: `Claude usage limit reached (rate_limit_event status=${lastEvent.status})`,
      resetsAt: resetsAtToIso(lastEvent.resetsAt),
    };
  }

  // No structured signal at all in this batch - fall back to the (now tool-result-guarded)
  // text heuristic.
  for (const message of messages) {
    if (!message.data) continue;
    for (const line of message.data.split(/\r?\n/)) {
      const info = detectClaudeUsageLimitLine(line);
      if (info) return info;
    }
  }
  return null;
}

export function isClaudeUsageLimitStats(stats: string | null | undefined): boolean {
  if (!stats) return false;
  try {
    const parsed = JSON.parse(stats) as Record<string, unknown>;
    return parsed.rateLimited === true && parsed.rateLimitKind === "claude-usage-limit";
  } catch {
    return false;
  }
}
