import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
} from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { DisplayEvent } from "./claude-output-parser.js";

export class PiOutputParser {
  readonly format = "pi-jsonl" as const;
  readonly label = "pi-jsonl";

  private buffer = "";
  private readonly context = createAgentStreamParseContext();

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
    const parsed = parseAgentStreamLine("pi", line, this.context);
    if (!parsed) {
      try {
        JSON.parse(line);
        return [];
      } catch {
        return [{ kind: "raw", text: line }];
      }
    }
    return parsed.displayEvents ?? [];
  }
}
