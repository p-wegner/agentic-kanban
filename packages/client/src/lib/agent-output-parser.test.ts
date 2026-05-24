import { describe, expect, it } from "vitest";
import {
  CopilotOutputParser,
  createAgentOutputParser,
  getOutputFormatForAgent,
  getOutputFormatForProvider,
  RawOutputParser,
} from "./agent-output-parser.js";

describe("agent output parser factory", () => {
  it("creates the Claude stream-json parser by default", () => {
    const parser = createAgentOutputParser();

    expect(parser.format).toBe("claude-stream-json");
    expect(parser.label).toBe("stream-json");
  });

  it("creates a raw parser for unstructured agent output", () => {
    const parser = createAgentOutputParser("raw");

    expect(parser).toBeInstanceOf(RawOutputParser);
    expect(parser.feed("hello\n")).toEqual([{ kind: "raw", text: "hello" }]);
  });

  it("buffers partial raw output until a newline or flush", () => {
    const parser = new RawOutputParser();

    expect(parser.feed("hel")).toEqual([]);
    expect(parser.feed("lo\nnext")).toEqual([{ kind: "raw", text: "hello" }]);
    expect(parser.flush()).toEqual([{ kind: "raw", text: "next" }]);
  });

  it("creates the Copilot JSONL parser", () => {
    const parser = createAgentOutputParser("copilot-jsonl");

    expect(parser).toBeInstanceOf(CopilotOutputParser);
    expect(parser.format).toBe("copilot-jsonl");
    expect(parser.label).toBe("copilot-jsonl");
  });
});

describe("CopilotOutputParser", () => {
  it("parses session, assistant, tool, and stats events", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({ type: "session.started", session_id: "copilot-123", model: "gpt-5.2", cwd: "/repo" }),
      JSON.stringify({ type: "assistant_message", text: "I will inspect the parser." }),
      JSON.stringify({ type: "tool_call.started", id: "tool-1", name: "bash", input: { command: "pnpm test" } }),
      JSON.stringify({ type: "tool_call.completed", id: "tool-1", result: "Tests passed", status: "completed" }),
      JSON.stringify({ type: "stats", usage: { input_tokens: 12, output_tokens: 34 }, duration_ms: 1234, model: "gpt-5.2" }),
    ].join("\n") + "\n";

    expect(parser.feed(output)).toEqual([
      {
        kind: "init",
        model: "gpt-5.2",
        sessionId: "copilot-123",
        cwd: "/repo",
        tools: [],
        mcpServers: [],
        permissionMode: "",
      },
      { kind: "assistant", text: "I will inspect the parser.", model: "" },
      {
        kind: "tool_use",
        id: "tool-1",
        name: "bash",
        input: JSON.stringify({ command: "pnpm test" }),
        inputParsed: { command: "pnpm test" },
      },
      {
        kind: "tool_result",
        toolName: "bash",
        toolUseId: "tool-1",
        output: "Tests passed",
        isError: false,
      },
      {
        kind: "result",
        success: true,
        durationMs: 1234,
        result: "",
        totalCostUsd: 0,
        inputTokens: 12,
        outputTokens: 34,
        model: "gpt-5.2",
      },
    ]);
  });

  it("falls back to raw output for invalid or unrecognized lines", () => {
    const parser = new CopilotOutputParser();

    expect(parser.feed("plain text\n")).toEqual([{ kind: "raw", text: "plain text" }]);
    expect(parser.feed(JSON.stringify({ type: "progress", message: "Working" }) + "\n")).toEqual([
      { kind: "raw", text: "Working" },
    ]);
  });
});

describe("getOutputFormatForAgent", () => {
  it("returns claude-stream-json for undefined (default agent)", () => {
    expect(getOutputFormatForAgent()).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for empty string", () => {
    expect(getOutputFormatForAgent("")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for claude command", () => {
    expect(getOutputFormatForAgent("claude")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("claude.exe")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for full claude path", () => {
    expect(getOutputFormatForAgent("C:\\Users\\test\\.claude\\local\\claude.exe")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("/usr/local/bin/claude")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for mock-agent", () => {
    expect(getOutputFormatForAgent("node mock-agent.ts")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("/some/path/mock-agent-foo")).toBe("claude-stream-json");
  });

  it("returns codex-jsonl for codex command", () => {
    expect(getOutputFormatForAgent("codex")).toBe("codex-jsonl");
    expect(getOutputFormatForAgent("codex.cmd")).toBe("codex-jsonl");
    expect(getOutputFormatForAgent("C:\\Users\\test\\scoop\\codex.cmd")).toBe("codex-jsonl");
  });

  it("returns copilot-jsonl for copilot command", () => {
    expect(getOutputFormatForAgent("copilot")).toBe("copilot-jsonl");
    expect(getOutputFormatForAgent("copilot.cmd")).toBe("copilot-jsonl");
    expect(getOutputFormatForAgent("C:\\Users\\test\\AppData\\Local\\GitHub\\copilot.exe")).toBe("copilot-jsonl");
  });

  it("returns raw for other agent commands", () => {
    expect(getOutputFormatForAgent("aider")).toBe("raw");
    expect(getOutputFormatForAgent("custom-agent")).toBe("raw");
    expect(getOutputFormatForAgent("/usr/bin/python3 agent.py")).toBe("raw");
  });
});

describe("getOutputFormatForProvider", () => {
  it("returns claude-stream-json for undefined/null (default)", () => {
    expect(getOutputFormatForProvider()).toBe("claude-stream-json");
    expect(getOutputFormatForProvider(null)).toBe("claude-stream-json");
    expect(getOutputFormatForProvider(undefined)).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for claude provider", () => {
    expect(getOutputFormatForProvider("claude")).toBe("claude-stream-json");
  });

  it("returns codex-jsonl for codex provider", () => {
    expect(getOutputFormatForProvider("codex")).toBe("codex-jsonl");
  });

  it("returns copilot-jsonl for copilot provider", () => {
    expect(getOutputFormatForProvider("copilot")).toBe("copilot-jsonl");
  });

  it("returns raw for unknown providers", () => {
    expect(getOutputFormatForProvider("aider")).toBe("raw");
    expect(getOutputFormatForProvider("custom")).toBe("raw");
  });
});
