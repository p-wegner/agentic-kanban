import { describe, expect, it } from "vitest";
import { createAgentOutputParser, getOutputFormatForAgent, getOutputFormatForProvider, RawOutputParser } from "./agent-output-parser.js";

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

  it("returns raw for codex command", () => {
    expect(getOutputFormatForAgent("codex")).toBe("raw");
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

  it("returns raw for unknown providers", () => {
    expect(getOutputFormatForProvider("aider")).toBe("raw");
    expect(getOutputFormatForProvider("custom")).toBe("raw");
  });
});
