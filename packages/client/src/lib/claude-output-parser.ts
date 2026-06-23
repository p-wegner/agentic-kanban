import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
  type AgentDisplayAssistantEvent as ParsedAssistantEvent,
  type AgentDisplayEvent as DisplayEvent,
  type AgentDisplayImageEvent as ParsedImageEvent,
  type AgentDisplayInitEvent as ParsedInitEvent,
  type AgentDisplayNotificationEvent as ParsedNotificationEvent,
  type AgentDisplayRateLimitEvent as ParsedRateLimitEvent,
  type AgentDisplayResultEvent as ParsedResultEvent,
  type AgentDisplayTaskStartedEvent as ParsedTaskStartedEvent,
  type AgentDisplayThinkingEvent as ParsedThinkingEvent,
  type AgentDisplayToolResultEvent as ParsedToolResultEvent,
  type AgentDisplayToolUseEvent as ParsedToolUseEvent,
  type AgentStreamProvider,
} from "@agentic-kanban/shared/lib/agent-stream-parser";

export type {
  DisplayEvent,
  ParsedAssistantEvent,
  ParsedImageEvent,
  ParsedInitEvent,
  ParsedNotificationEvent,
  ParsedRateLimitEvent,
  ParsedResultEvent,
  ParsedTaskStartedEvent,
  ParsedThinkingEvent,
  ParsedToolResultEvent,
  ParsedToolUseEvent,
};

export type ParsedEvent = Exclude<DisplayEvent, { kind: "raw" }>;
export type RawTextEvent = Extract<DisplayEvent, { kind: "raw" }>;

class SharedJsonlOutputParser {
  private buffer = "";
  private readonly context = createAgentStreamParseContext();
  private _isJson = false;

  constructor(
    private readonly provider: AgentStreamProvider,
    readonly format: string,
    readonly label: string,
  ) {}

  get isJson(): boolean {
    return this._isJson;
  }

  feed(data: string): DisplayEvent[] {
    this.buffer += data;
    const events: DisplayEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      events.push(...this.parseLine(line));
    }

    return events;
  }

  flush(): DisplayEvent[] {
    if (!this.buffer.trim()) return [];
    const events = this.parseLine(this.buffer.trim());
    this.buffer = "";
    return events;
  }

  private parseLine(line: string): DisplayEvent[] {
    const parsed = parseAgentStreamLine(this.provider, line, this.context);
    if (!parsed) {
      try {
        JSON.parse(line);
        this._isJson = true;
        return [];
      } catch {
        return [{ kind: "raw", text: line }];
      }
    }
    this._isJson = true;
    return parsed.displayEvents ?? [];
  }
}

export class ClaudeOutputParser {
  private readonly parser = new SharedJsonlOutputParser("claude", "claude-stream-json", "stream-json");
  readonly format = "claude-stream-json";
  readonly label = "stream-json";

  get isClaudeJson(): boolean {
    return this.parser.isJson;
  }

  feed(data: string): DisplayEvent[] {
    return this.parser.feed(data);
  }

  flush(): DisplayEvent[] {
    return this.parser.flush();
  }
}
