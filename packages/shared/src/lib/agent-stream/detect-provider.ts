import type { AgentStreamProvider } from "./types.js";
import { recordUnknownFieldDrift } from "./unknown-fields.js";

// Offline provider detection for stored session JSONL (#951).
//
// Live streams know their provider up front, so the per-provider parsers take it
// as an argument. The offline session-summary parser reads persisted
// session_messages rows that do NOT record the provider, so it detects the
// provider PER EVENT from the wire `type` and routes the line to the canonical
// parser (agent-stream/{claude,codex,copilot,pi}.ts). This keeps interpretation
// in exactly one place — session-summary must never re-implement field parsing.
//
// Since arch-review §2.4 (Ticket 13) rows may carry a stored `provider` — when
// present the caller passes it and this per-event guessing is skipped entirely.
// The catch-all no longer SILENTLY claims an unrecognized event is Copilot
// (misreporting a session's provider is worse than an explicit unknown): use
// detectAgentEventProviderOrUnknown, which returns "unknown" and logs the drift.
// The tolerant Copilot parser is still used to READ an unknown line, but the
// classification is reported as unknown, not copilot.

const CLAUDE_EVENT_TYPES = new Set([
  "system",
  "user",
  "result",
  "rate_limit_event",
]);

const CODEX_EVENT_TYPES = new Set([
  "thread.started",
  "item.started",
  "item.updated",
  "item.completed",
  "turn.completed",
  "turn.failed",
  "error",
]);

const PI_EVENT_TYPES = new Set([
  "session",
  "message_update",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "rate_limit",
]);

/**
 * Classify a parsed JSONL event object to the agent provider whose wire format
 * it belongs to. Ambiguities are resolved the way the pre-#951 session-summary
 * dispatch chain did:
 * - bare `result` and `rate_limit_event` → Claude (Copilot's result-shaped
 *   events all carry distinct type names; `result` was always routed to the
 *   Claude handler),
 * - `assistant` with a `message.content` array → Claude streaming; `assistant`
 *   without content blocks → Copilot CLI nested format,
 * - `error` → Codex (Pi's `error` events are display-only either way),
 * - everything unrecognized → "unknown" (see detectAgentEventProviderOrUnknown).
 */
export function detectAgentEventProviderOrUnknown(
  obj: Record<string, unknown>,
): AgentStreamProvider | "unknown" {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "assistant") {
    const message = obj.message;
    const content = typeof message === "object" && message !== null
      ? (message as Record<string, unknown>).content
      : undefined;
    // Claude streams assistant text as a `message.content` array; Copilot CLI
    // nests it differently. A content-less `assistant` is Copilot's shape.
    return Array.isArray(content) ? "claude" : "copilot";
  }
  if (CLAUDE_EVENT_TYPES.has(type)) return "claude";
  if (CODEX_EVENT_TYPES.has(type)) return "codex";
  if (PI_EVENT_TYPES.has(type)) return "pi";
  // arch-review §2.4: an unrecognized event used to be SILENTLY called Copilot,
  // which misreported the session's provider. Report it as unknown + log the
  // drift (rate-limited) so it is observable; the caller still parses the line
  // with the tolerant Copilot parser but does not classify the session as copilot.
  recordUnknownFieldDrift("unknown", type || "<no-type>", "offline provider detection: unrecognized event shape");
  return "unknown";
}

/**
 * Back-compat wrapper: classify to a concrete provider, mapping the explicit
 * "unknown" onto the tolerant Copilot parser (the historical catch-all) so
 * existing parser-routing callers keep working. Prefer
 * detectAgentEventProviderOrUnknown when the classification itself matters.
 */
export function detectAgentEventProvider(obj: Record<string, unknown>): AgentStreamProvider {
  const provider = detectAgentEventProviderOrUnknown(obj);
  return provider === "unknown" ? "copilot" : provider;
}
