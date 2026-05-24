import { ClaudeOutputParser, type DisplayEvent } from "./claude-output-parser.js";
import { CodexOutputParser } from "./codex-output-parser.js";

export type { DisplayEvent } from "./claude-output-parser.js";

export type AgentOutputFormat = "claude-stream-json" | "codex-jsonl" | "raw";

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
      if (line.length > 0) {
        events.push({ kind: "raw", text: line });
      }
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

const CLAUDE_COMMANDS = ["claude", "claude.exe"];
const CODEX_COMMANDS = ["codex"];

export function getOutputFormatForProvider(provider?: string | null): AgentOutputFormat {
  if (!provider || provider === "claude") return "claude-stream-json";
  if (provider === "codex") return "codex-jsonl";
  return "raw";
}

export function getOutputFormatForAgent(agentCommand?: string): AgentOutputFormat {
  if (!agentCommand) return "claude-stream-json";
  const base = agentCommand.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, "")?.toLowerCase() ?? "";
  if (CLAUDE_COMMANDS.includes(base) || base.includes("mock-agent")) return "claude-stream-json";
  if (CODEX_COMMANDS.includes(base)) return "codex-jsonl";
  return "raw";
}

export function createAgentOutputParser(format: AgentOutputFormat = "claude-stream-json"): AgentOutputParser {
  switch (format) {
    case "raw":
      return new RawOutputParser();
    case "codex-jsonl":
      return new CodexOutputParser();
    case "claude-stream-json":
    default:
      return new ClaudeOutputParser();
  }
}
