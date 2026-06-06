import type { AgentOutputMessage } from "@agentic-kanban/shared";

export interface CodexUsageLimitInfo {
  message: string;
  retryAfter: string | null;
}

export const CODEX_USAGE_LIMIT_PATTERN = /you(?:['\u2019])?ve hit your usage limit for\s+(.+?)(?:\.|$)/i;
const RETRY_AFTER_PATTERN = /try again at\s+(.+?)(?:\.|$)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function detectCodexUsageLimitText(text: string | null | undefined): CodexUsageLimitInfo | null {
  if (!text || !CODEX_USAGE_LIMIT_PATTERN.test(text)) return null;
  const retryAfter = RETRY_AFTER_PATTERN.exec(text)?.[1]?.trim() || null;
  return { message: text.trim(), retryAfter };
}

function detectCodexUsageLimitLine(line: string): CodexUsageLimitInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const direct = detectCodexUsageLimitText(trimmed);
  if (direct) return direct;

  try {
    const record = asRecord(JSON.parse(trimmed) as unknown);
    if (!record) return null;

    if (typeof record.message === "string") {
      const info = detectCodexUsageLimitText(record.message);
      if (info) return info;
    }

    const error = asRecord(record.error);
    if (typeof error?.message === "string") {
      const info = detectCodexUsageLimitText(error.message);
      if (info) return info;
    }
  } catch {
    return null;
  }

  return null;
}

export function detectCodexUsageLimitMessages(messages: AgentOutputMessage[]): CodexUsageLimitInfo | null {
  for (const message of messages) {
    if (!message.data) continue;
    for (const line of message.data.split(/\r?\n/)) {
      const info = detectCodexUsageLimitLine(line);
      if (info) return info;
    }
  }
  return null;
}

export function isCodexUsageLimitStats(stats: string | null | undefined): boolean {
  if (!stats) return false;
  try {
    const parsed = JSON.parse(stats) as Record<string, unknown>;
    return parsed.rateLimited === true && parsed.rateLimitKind === "codex-usage-limit";
  } catch {
    return false;
  }
}
