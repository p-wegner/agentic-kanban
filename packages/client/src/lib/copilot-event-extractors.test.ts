import { describe, expect, it } from "vitest";
import {
  asRecord,
  contentToText,
  extractAssistantText,
  extractResult,
  extractToolResult,
  extractToolUse,
  formatShutdownResult,
  getString,
  getStringArray,
  normalizedType,
  stringifyValue,
} from "./copilot-event-extractors.js";

describe("normalizedType", () => {
  it("reads type, then event, then name", () => {
    expect(normalizedType({ type: "session.start" })).toBe("session.start");
    expect(normalizedType({ event: "tool_call" })).toBe("tool_call");
    expect(normalizedType({ name: "Result" })).toBe("result");
  });

  it("lowercases and converts dashes to underscores", () => {
    expect(normalizedType({ type: "Tool-Call-Started" })).toBe("tool_call_started");
  });

  it("returns empty string when no type-like field exists", () => {
    expect(normalizedType({})).toBe("");
    expect(normalizedType({ other: "x" })).toBe("");
  });
});

describe("getString", () => {
  it("returns the first non-empty string among the given keys", () => {
    expect(getString({ a: "", b: "  ", c: "found" }, ["a", "b", "c"])).toBe("found");
  });

  it("ignores non-string values", () => {
    expect(getString({ a: 42, b: ["x"], c: "ok" }, ["a", "b", "c"])).toBe("ok");
  });

  it("returns empty string when nothing matches", () => {
    expect(getString({}, ["missing"])).toBe("");
  });
});

describe("getStringArray", () => {
  it("filters non-string items", () => {
    expect(getStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });

  it("returns empty array for non-arrays", () => {
    expect(getStringArray("not-an-array")).toEqual([]);
    expect(getStringArray(undefined)).toEqual([]);
  });
});

describe("asRecord", () => {
  it("returns plain objects unchanged", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns undefined for arrays, null, and primitives", () => {
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord("str")).toBeUndefined();
    expect(asRecord(7)).toBeUndefined();
  });
});

describe("stringifyValue", () => {
  it("passes strings through", () => {
    expect(stringifyValue("hello")).toBe("hello");
  });

  it("returns empty string for undefined", () => {
    expect(stringifyValue(undefined)).toBe("");
  });

  it("JSON-stringifies other values", () => {
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
    expect(stringifyValue(5)).toBe("5");
  });
});

describe("contentToText", () => {
  it("passes strings through", () => {
    expect(contentToText("plain")).toBe("plain");
  });

  it("joins text from block arrays", () => {
    expect(contentToText([{ text: "one" }, "two", { content: "three" }])).toBe("one\ntwo\nthree");
  });

  it("drops blocks without usable text", () => {
    expect(contentToText([{ other: "x" }, { text: "kept" }, 42])).toBe("kept");
  });

  it("returns empty string for non-string non-array input", () => {
    expect(contentToText({ text: "obj" })).toBe("");
    expect(contentToText(undefined)).toBe("");
  });
});

describe("formatShutdownResult", () => {
  it("formats line counts and file count", () => {
    expect(formatShutdownResult("routine", 50, 10, ["a.ts", "b.ts"])).toBe("routine — +50/-10 lines in 2 files");
  });

  it("uses singular 'file' for one file", () => {
    expect(formatShutdownResult("", 1, 0, ["a.ts"])).toBe("+1/-0 lines in 1 file");
  });

  it("falls back to the shutdown type when no files were modified", () => {
    expect(formatShutdownResult("routine", 0, 0, [])).toBe("routine");
    expect(formatShutdownResult("", 0, 0, [])).toBe("");
  });
});

describe("extractAssistantText", () => {
  it("reads assistant.message data content", () => {
    expect(extractAssistantText({ type: "assistant.message", data: { content: "hi" } })).toBe("hi");
  });

  it("reads top-level assistant_message text", () => {
    expect(extractAssistantText({ type: "assistant_message", text: "hello" })).toBe("hello");
  });

  it("reads nested message content for role assistant", () => {
    expect(extractAssistantText({ role: "assistant", message: { content: [{ text: "block" }] } })).toBe("block");
  });

  it("reads message-type events with assistant role", () => {
    expect(extractAssistantText({ type: "message", role: "assistant", text: "from message" })).toBe("from message");
  });

  it("returns empty string for non-assistant events", () => {
    expect(extractAssistantText({ type: "user.message", data: { content: "nope" } })).toBe("");
  });
});

describe("extractToolUse", () => {
  it("returns null for non-tool-use types", () => {
    expect(extractToolUse({ type: "assistant.message" })).toBeNull();
  });

  it("extracts id, name, and object input", () => {
    expect(extractToolUse({ type: "tool_call.started", id: "t1", name: "bash", input: { command: "ls" } })).toEqual({
      id: "t1",
      name: "bash",
      input: JSON.stringify({ command: "ls" }),
      inputParsed: { command: "ls" },
    });
  });

  it("parses JSON string arguments into inputParsed", () => {
    const args = JSON.stringify({ pattern: "TODO" });
    const result = extractToolUse({
      type: "tool.execution_start",
      data: { toolCallId: "t2", toolName: "grep", arguments: args },
    });
    expect(result).toEqual({ id: "t2", name: "grep", input: args, inputParsed: { pattern: "TODO" } });
  });

  it("keeps inputParsed empty for malformed JSON string input", () => {
    const result = extractToolUse({ type: "tool_use", id: "t3", name: "bash", input: "{not json" });
    expect(result).toEqual({ id: "t3", name: "bash", input: "{not json", inputParsed: {} });
  });

  it("defaults the name to copilot_tool", () => {
    expect(extractToolUse({ type: "tool_call", id: "t4" })?.name).toBe("copilot_tool");
  });
});

describe("extractToolResult", () => {
  it("returns null for non-tool-result types", () => {
    expect(extractToolResult({ type: "tool_call" }, new Map())).toBeNull();
  });

  it("extracts output and resolves the tool name from the map", () => {
    const map = new Map([["t1", "bash"]]);
    expect(extractToolResult({ type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "done" } } }, map)).toEqual({
      toolName: "bash",
      toolUseId: "t1",
      output: "done",
      isError: false,
    });
  });

  it("falls back to copilot_tool when the name is unknown", () => {
    const result = extractToolResult({ type: "tool_result", id: "missing", output: "x" }, new Map());
    expect(result?.toolName).toBe("copilot_tool");
  });

  it("flags errors from success=false, error fields, and status", () => {
    const map = new Map<string, string>();
    expect(extractToolResult({ type: "tool_result", id: "a", success: false }, map)?.isError).toBe(true);
    expect(extractToolResult({ type: "tool_result", id: "b", error: "boom" }, map)?.isError).toBe(true);
    expect(extractToolResult({ type: "tool_result", id: "c", status: "failed" }, map)?.isError).toBe(true);
    expect(extractToolResult({ type: "tool_result", id: "d", status: "completed" }, map)?.isError).toBe(false);
  });
});

describe("extractResult", () => {
  it("returns null for non-result types", () => {
    expect(extractResult({ type: "assistant.message" })).toBeNull();
  });

  it("extracts duration, tokens, and model from usage", () => {
    expect(extractResult({
      type: "stats",
      usage: { input_tokens: 12, output_tokens: 34 },
      duration_ms: 1234,
      model: "gpt-5.2",
    })).toEqual({
      success: true,
      durationMs: 1234,
      result: "",
      inputTokens: 12,
      outputTokens: 34,
      model: "gpt-5.2",
    });
  });

  it("reads camelCase usage from a nested data payload", () => {
    const result = extractResult({
      type: "result",
      data: { exitCode: 0, usage: { inputTokens: 10, outputTokens: 5, sessionDurationMs: 123 } },
    });
    expect(result).toEqual({
      success: true,
      durationMs: 123,
      result: "",
      inputTokens: 10,
      outputTokens: 5,
      model: "",
    });
  });

  it("marks failures from exitCode, error flags, and status", () => {
    expect(extractResult({ type: "result", exitCode: 1 })?.success).toBe(false);
    expect(extractResult({ type: "result", is_error: true })?.success).toBe(false);
    expect(extractResult({ type: "result", status: "failed" })?.success).toBe(false);
    expect(extractResult({ type: "done", error: "boom" })?.success).toBe(false);
  });

  it("uses the error value as the result text when no message is present", () => {
    expect(extractResult({ type: "result", error: "boom" })?.result).toBe("boom");
  });
});
