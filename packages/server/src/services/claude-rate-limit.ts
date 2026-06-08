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
  /claude (?:ai )?usage limit reached|(?:5-hour|weekly|session) limit reached|usage limit.*reset/i;
const RESET_AT_PATTERN = /reset(?:s)?\s+at\s+(.+?)(?:\.|$)/i;

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

function detectClaudeUsageLimitLine(line: string): ClaudeUsageLimitInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const direct = detectClaudeUsageLimitText(trimmed);
  if (direct) return direct;

  try {
    const record = asRecord(JSON.parse(trimmed) as unknown);
    if (!record) return null;

    // Structured rate_limit_event from the stream-json output. A `rejected` status
    // (or an exhausted unified rate-limit) means the subscription can't continue.
    if (record.type === "rate_limit_event") {
      const info = asRecord(record.rate_limit_info);
      const status = typeof info?.status === "string" ? info.status : "";
      if (status === "rejected" || status === "blocked" || status === "exhausted") {
        return {
          message: `Claude usage limit reached (rate_limit_event status=${status})`,
          resetsAt: resetsAtToIso(info?.resetsAt),
        };
      }
    }

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
  } catch {
    return null;
  }

  return null;
}

export function detectClaudeUsageLimitMessages(messages: AgentOutputMessage[]): ClaudeUsageLimitInfo | null {
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
