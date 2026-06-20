import { describe, it, expect } from "vitest";
import {
  extractLastAgentMessageFromRows,
  extractAssistantMessage,
  extractToolName,
  safeParseStringArray,
} from "./session-message-extraction.js";

function row(type: string | null, data: string | null) {
  return { type, data };
}
function assistant(...texts: string[]): string {
  return JSON.stringify({ type: "assistant", message: { content: texts.map((text) => ({ type: "text", text })) } });
}

describe("extractLastAgentMessageFromRows", () => {
  it("returns null with no rows / no stdout rows", () => {
    expect(extractLastAgentMessageFromRows([])).toBeNull();
    expect(extractLastAgentMessageFromRows([row("system", "x"), row("stdout", null)])).toBeNull();
  });

  it("extracts an assistant text block", () => {
    expect(extractLastAgentMessageFromRows([row("stdout", assistant("hello world"))])).toBe("hello world");
  });

  it("keeps the FIRST original-order text block within an assistant message", () => {
    // distinguishes this from extractAssistantMessage (which keeps the last)
    expect(extractLastAgentMessageFromRows([row("stdout", assistant("first", "second"))])).toBe("first");
  });

  it("stops at the first row that yields a message", () => {
    const data = [assistant("from-first-row"), "junk"].join("\n");
    expect(extractLastAgentMessageFromRows([row("stdout", data), row("stdout", assistant("from-second-row"))])).toBe("from-first-row");
  });

  it("handles the assistant.message provider shape (string + array content)", () => {
    const arr = JSON.stringify({ type: "assistant.message", data: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
    expect(extractLastAgentMessageFromRows([row("stdout", arr)])).toBe("a\nb");
    const str = JSON.stringify({ type: "assistant.message", data: { content: "plain" } });
    expect(extractLastAgentMessageFromRows([row("stdout", str)])).toBe("plain");
  });

  it("handles the item.completed agent_message shape", () => {
    const j = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    expect(extractLastAgentMessageFromRows([row("stdout", j)])).toBe("done");
  });

  it("ignores non-JSON lines", () => {
    const data = ["not json", assistant("ok"), "{broken"].join("\n");
    expect(extractLastAgentMessageFromRows([row("stdout", data)])).toBe("ok");
  });
});

describe("extractAssistantMessage", () => {
  it("returns the last original-order text block", () => {
    expect(extractAssistantMessage(assistant("one", "two"))).toBe("two");
  });
  it("returns null for junk", () => {
    expect(extractAssistantMessage("nope")).toBeNull();
  });
});

describe("extractToolName", () => {
  it("returns the first tool_use name", () => {
    const j = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    expect(extractToolName(j)).toBe("Bash");
  });
  it("returns null when no tool_use", () => {
    expect(extractToolName(assistant("text only"))).toBeNull();
  });
});

describe("safeParseStringArray", () => {
  it("parses a string array, filtering non-strings", () => {
    expect(safeParseStringArray('["a", 1, "b", null]')).toEqual(["a", "b"]);
  });
  it("returns [] for null / non-array / invalid json", () => {
    expect(safeParseStringArray(null)).toEqual([]);
    expect(safeParseStringArray("{}")).toEqual([]);
    expect(safeParseStringArray("nope")).toEqual([]);
  });
});
