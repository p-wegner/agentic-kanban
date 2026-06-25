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
import { parseCopilotEvent } from "./agent-stream/copilot.js";
import { parsePiEvent } from "./agent-stream/pi.js";

export { createAgentStreamParseContext } from "./agent-stream/shared.js";

type ParseContext = ReturnType<typeof createAgentStreamParseContext>;

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
