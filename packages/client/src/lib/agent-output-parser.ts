import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
} from "@agentic-kanban/shared/lib/agent-stream-parser";
import { ClaudeOutputParser, type DisplayEvent } from "./claude-output-parser.js";
import { CodexOutputParser } from "./codex-output-parser.js";
import { PiOutputParser } from "./pi-output-parser.js";

export type { DisplayEvent } from "./claude-output-parser.js";

export type AgentOutputFormat = "claude-stream-json" | "codex-jsonl" | "copilot-jsonl" | "pi-jsonl" | "raw";

export interface AgentOutputParser {
  readonly format: AgentOutputFormat;
  readonly label: string;
  feed(data: string): DisplayEvent[];
  flush(): DisplayEvent[];
}

export class RawOutputParser implements AgentOutputParser {
  readonly format = "raw";
  readonly label = "raw";

  private buffer = "";

  feed(data: string): DisplayEvent[] {
    this.buffer += data;
    const events: DisplayEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) events.push({ kind: "raw", text: line });
    }

    return events;
  }

  flush(): DisplayEvent[] {
    if (!this.buffer) return [];
    const text = this.buffer;
    this.buffer = "";
    return [{ kind: "raw", text }];
  }
}

export class CopilotOutputParser implements AgentOutputParser {
  readonly format = "copilot-jsonl";
  readonly label = "copilot-jsonl";

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
    const parsed = parseAgentStreamLine("copilot", line, this.context);
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

const CLAUDE_COMMANDS = ["claude", "claude.exe"];
const CODEX_COMMANDS = ["codex"];
const COPILOT_COMMANDS = ["copilot"];
const PI_COMMANDS = ["pi"];

export function getOutputFormatForProvider(provider?: string | null): AgentOutputFormat {
  if (!provider || provider === "claude") return "claude-stream-json";
  if (provider === "codex") return "codex-jsonl";
  if (provider === "copilot") return "copilot-jsonl";
  if (provider === "pi") return "pi-jsonl";
  return "raw";
}

export function getOutputFormatForAgent(agentCommand?: string): AgentOutputFormat {
  if (!agentCommand) return "claude-stream-json";
  const base = agentCommand.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, "")?.toLowerCase() ?? "";
  if (CLAUDE_COMMANDS.includes(base) || base.includes("mock-agent")) return "claude-stream-json";
  if (CODEX_COMMANDS.includes(base)) return "codex-jsonl";
  if (COPILOT_COMMANDS.includes(base)) return "copilot-jsonl";
  if (PI_COMMANDS.includes(base)) return "pi-jsonl";
  return "raw";
}

export function createAgentOutputParser(format: AgentOutputFormat = "claude-stream-json"): AgentOutputParser {
  switch (format) {
    case "raw":
      return new RawOutputParser();
    case "codex-jsonl":
      return new CodexOutputParser();
    case "copilot-jsonl":
      return new CopilotOutputParser();
    case "pi-jsonl":
      return new PiOutputParser();
    case "claude-stream-json":
    default:
      return new ClaudeOutputParser();
  }
}
