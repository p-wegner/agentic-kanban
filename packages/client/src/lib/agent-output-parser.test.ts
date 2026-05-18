import { describe, expect, it } from "vitest";
import { createAgentOutputParser, RawOutputParser } from "./agent-output-parser.js";

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
