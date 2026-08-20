import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
  type AgentDisplayEvent,
  type AgentDisplayToolResultEvent,
  type AgentStreamProvider,
} from "@agentic-kanban/shared/lib/agent-stream-parser";

const PROVIDERS: AgentStreamProvider[] = ["claude", "codex", "pi", "copilot"];

interface ParsedLine {
  provider: AgentStreamProvider;
  events: AgentDisplayEvent[];
  assistantText?: string;
  toolActivityName?: string;
  toolResultText?: string;
}

export interface AgentStreamExtractionContext {
  contexts: Map<AgentStreamProvider, ReturnType<typeof createAgentStreamParseContext>>;
}

export function createAgentStreamExtractionContext(): AgentStreamExtractionContext {
  return { contexts: new Map() };
}

function contextFor(
  extractionContext: AgentStreamExtractionContext,
  provider: AgentStreamProvider,
): ReturnType<typeof createAgentStreamParseContext> {
  let context = extractionContext.contexts.get(provider);
  if (!context) {
    context = createAgentStreamParseContext();
    extractionContext.contexts.set(provider, context);
  }
  return context;
}

export function parseAgentStreamExtractionLine(
  line: string,
  extractionContext = createAgentStreamExtractionContext(),
): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const provider of PROVIDERS) {
    const parsed = parseAgentStreamLine(provider, trimmed, contextFor(extractionContext, provider));
    if (!parsed) continue;
    const events = parsed.displayEvents ?? [];
    const onlyRawDisplay = events.length > 0 && events.every((event) => event.kind === "raw");
    if (
      onlyRawDisplay &&
      !parsed.assistantText &&
      !parsed.toolActivity &&
      !parsed.toolResult &&
      !parsed.stats &&
      !parsed.providerSessionId
    ) {
      continue;
    }
    const toolResultText = parsed.toolResult?.agentResultText
      ?? events.find(
        (event): event is AgentDisplayToolResultEvent => event.kind === "tool_result" && Boolean(event.output),
      )?.output;
    return {
      provider,
      events,
      assistantText: parsed.assistantText,
      toolActivityName: parsed.toolActivity?.name,
      toolResultText,
    };
  }

  return null;
}

export function extractAssistantTextsFromLine(
  line: string,
  extractionContext = createAgentStreamExtractionContext(),
): string[] {
  const parsed = parseAgentStreamExtractionLine(line, extractionContext);
  if (!parsed) return [];
  const texts = parsed.events
    .filter((event): event is Extract<AgentDisplayEvent, { kind: "assistant" }> => event.kind === "assistant")
    .map((event) => event.text)
    .filter((text) => text.trim());
  if (texts.length > 0) return texts;
  return parsed.assistantText?.trim() ? [parsed.assistantText] : [];
}

export function extractFirstToolNameFromLine(
  line: string,
  extractionContext = createAgentStreamExtractionContext(),
): string | null {
  const parsed = parseAgentStreamExtractionLine(line, extractionContext);
  if (!parsed) return null;
  const toolUse = parsed.events.find((event): event is Extract<AgentDisplayEvent, { kind: "tool_use" }> => event.kind === "tool_use");
  return toolUse?.name ?? parsed.toolActivityName ?? null;
}

export function extractToolResultTextFromLine(
  line: string,
  extractionContext = createAgentStreamExtractionContext(),
): string | null {
  const parsed = parseAgentStreamExtractionLine(line, extractionContext);
  if (!parsed) return null;
  return parsed.toolResultText?.trim() ? parsed.toolResultText : null;
}
