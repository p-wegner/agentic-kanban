// Facade for the per-provider agent stream parsers (arch-review #888).
//
// The provider-specific parsers were extracted into ./agent-stream/{claude,codex,
// copilot,pi}.ts behind this facade so no single module is a 1000+ line god-file
// (see git-service.ts / workflow-engine.ts for the same pattern). This module
// keeps the PUBLIC contract: the display-event types, ParsedStreamEvent, the
// parse context factory, and the two dispatch entry points. Consumers import
// from "@agentic-kanban/shared/lib/agent-stream-parser" exactly as before.

export type {
  AgentStreamProvider,
  AgentDisplayInitEvent,
  AgentDisplayAssistantEvent,
  AgentDisplayThinkingEvent,
  AgentDisplayResultEvent,
  AgentDisplayToolUseEvent,
  AgentDisplayToolResultEvent,
  AgentDisplayImageEvent,
  AgentDisplayTaskStartedEvent,
  AgentDisplayNotificationEvent,
  AgentDisplayRateLimitEvent,
  AgentDisplayRawEvent,
  AgentDisplayEvent,
  ParsedStreamEvent,
} from "./agent-stream/types.js";

import type { AgentStreamProvider, ParsedStreamEvent } from "./agent-stream/types.js";
import { createAgentStreamParseContext, hasProviderFields } from "./agent-stream/shared.js";
import { parseClaudeEvent } from "./agent-stream/claude.js";
import { parseCodexEvent } from "./agent-stream/codex.js";
import { isCopilotUnmatchedFallback, parseCopilotEvent } from "./agent-stream/copilot.js";
import { parsePiEvent } from "./agent-stream/pi.js";

export { createAgentStreamParseContext } from "./agent-stream/shared.js";
export {
  CODEX_USAGE_LIMIT_PATTERN,
  CODEX_RETRY_AFTER_PATTERN,
  matchCodexUsageLimitText,
  type CodexUsageLimitMatch,
} from "./agent-stream/codex.js";
export {
  recordUnknownAgentEvent,
  getUnknownEventCounters,
  resetUnknownEventCounters,
  setUnknownEventLogger,
  setUnknownEventClock,
  UNKNOWN_EVENT_ALERT_THRESHOLD,
  UNKNOWN_EVENT_ALERT_WINDOW_MS,
  type UnknownEventCounter,
  type UnknownEventLogger,
} from "./agent-stream/unknown-events.js";
export {
  recordUnknownFieldDrift,
  getUnknownFieldCounters,
  resetUnknownFieldCounters,
  setUnknownFieldLogger,
  setUnknownFieldClock,
  type UnknownFieldCounter,
  type UnknownFieldLogger,
} from "./agent-stream/unknown-fields.js";

import { recordUnknownAgentEvent } from "./agent-stream/unknown-events.js";

type ParseContext = ReturnType<typeof createAgentStreamParseContext>;

/** Classification of a single agent stream line against a provider's parser. */
export interface AgentStreamLineClassification {
  /** False when the line was not valid JSON (non-JSON output is expected noise). */
  validJson: boolean;
  /** True when a provider parser produced a usable ParsedStreamEvent. */
  recognized: boolean;
  /** The raw `type` field from the wire object, when present (for unknown-event observability). */
  eventType?: string;
  /** The parsed event, when recognized. */
  event?: ParsedStreamEvent;
}

/**
 * Parse a line AND classify it: distinguishes "non-JSON noise" from "valid JSON
 * the parser recognized" from "valid JSON of an UNKNOWN event type" — the last
 * being the silent-swallow case behind the recurring "0 tokens" misdiagnosis
 * (arch-review #898). Callers use this to observe wire-format drift; the parse
 * behavior itself is unchanged.
 */
export function classifyAgentStreamLine(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): AgentStreamLineClassification {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { validJson: false, recognized: false };
  }
  const eventType = typeof obj.type === "string" ? obj.type : undefined;
  const event = parseAgentStreamLine(provider, line, context);
  // The copilot parser keeps a `raw` display fallback for UI continuity, but that
  // fallback must count as UNKNOWN here — otherwise any JSON is "recognized" and
  // a Copilot CLI format change produces zero unknown-event counts (#968).
  const recognized = event !== undefined && !isCopilotUnmatchedFallback(event);
  return { validJson: true, recognized, eventType, event };
}

/**
 * Parse a line and, when it is valid JSON the parser did NOT recognize, record an
 * "unknown event type" metric/log before returning undefined. This is the
 * observable replacement for the bare `parseStreamEvent(line)` swallow at stream
 * hot paths — a CLI rename now surfaces loudly instead of producing a silent zero.
 */
export function parseAgentStreamLineObserved(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  const classification = classifyAgentStreamLine(provider, line, context);
  if (classification.validJson && !classification.recognized) {
    recordUnknownAgentEvent(provider, classification.eventType);
  }
  return classification.event;
}

export function parseAgentStreamLine(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  switch (provider) {
    case "claude":
      return parseClaudeEvent(obj, context);
    case "codex":
      return parseCodexEvent(obj, context);
    case "copilot":
      return parseCopilotEvent(obj, line, context);
    case "pi":
      return parsePiEvent(obj, context);
  }
}

export function parseAgentProviderStreamLine(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  const parsed = parseAgentStreamLine(provider, line, context);
  if (!parsed) return undefined;
  const providerEvent = { ...parsed };
  delete providerEvent.displayEvents;
  return hasProviderFields(providerEvent) ? providerEvent : undefined;
}

/**
 * Observed variant of parseAgentProviderStreamLine: records an "unknown event
 * type" metric/log when the line was valid JSON the parser did NOT recognize
 * (arch-review #898). "Recognized" means the underlying parser produced ANY event
 * — including one carrying only display events — so a recognized-but-no-provider-
 * fields line (which this still returns undefined for) is NOT counted as unknown.
 */
export function parseAgentProviderStreamLineObserved(
  provider: AgentStreamProvider,
  line: string,
  context: ParseContext = createAgentStreamParseContext(),
): ParsedStreamEvent | undefined {
  const classification = classifyAgentStreamLine(provider, line, context);
  if (classification.validJson && !classification.recognized) {
    recordUnknownAgentEvent(provider, classification.eventType);
  }
  if (!classification.event) return undefined;
  const providerEvent = { ...classification.event };
  delete providerEvent.displayEvents;
  return hasProviderFields(providerEvent) ? providerEvent : undefined;
}
