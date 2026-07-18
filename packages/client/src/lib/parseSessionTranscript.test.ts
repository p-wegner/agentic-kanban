import { describe, expect, it } from "vitest";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { extractUserText, parseSessionTranscript } from "./parseSessionTranscript.js";

function stdout(data: string): AgentOutputMessage {
  return { type: "stdout", sessionId: "s1", data };
}

const USER_LINE = JSON.stringify({
  type: "user",
  message: { content: [{ type: "text", text: "Please implement feature X" }] },
});
const THINKING_LINE = JSON.stringify({
  type: "assistant",
  message: { model: "claude-opus-4", content: [{ type: "thinking", thinking: "Let me plan the change." }] },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  message: { model: "claude-opus-4", content: [{ type: "text", text: "I'll run the tests." }] },
});
const TOOL_USE_LINE = JSON.stringify({
  type: "assistant",
  message: { model: "claude-opus-4", content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "pnpm test" } }] },
});
const TOOL_ERROR_LINE = JSON.stringify({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "tool_1", is_error: true, content: "command failed" }] },
});

describe("parseSessionTranscript", () => {
  it("turns claude stream-json lines into ordered, typed events", () => {
    const messages = [
      stdout(`${USER_LINE}\n${THINKING_LINE}\n${ASSISTANT_LINE}\n${TOOL_USE_LINE}\n${TOOL_ERROR_LINE}\n`),
    ];

    const events = parseSessionTranscript(messages, "claude-stream-json");

    expect(events.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool_call",
      "tool_error",
    ]);

    const [user, thinking, assistant, toolCall, toolError] = events;
    expect(user.text).toBe("Please implement feature X");
    expect(thinking.text).toBe("Let me plan the change.");
    expect(assistant.text).toBe("I'll run the tests.");
    expect(assistant.model).toBe("claude-opus-4");

    expect(toolCall.toolName).toBe("Bash");
    expect(toolCall.text).toBe("pnpm test");
    expect(toolCall.toolInput).toContain("pnpm test");

    // tool_result names resolve from the tool_use id registered earlier in the stream
    expect(toolError.toolName).toBe("Bash");
    expect(toolError.text).toBe("command failed");
  });

  it("reconstructs lines that straddle message boundaries", () => {
    const half = Math.floor(ASSISTANT_LINE.length / 2);
    const messages = [
      stdout(ASSISTANT_LINE.slice(0, half)),
      stdout(`${ASSISTANT_LINE.slice(half)}\n`),
    ];

    const events = parseSessionTranscript(messages, "claude-stream-json");

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("assistant");
    expect(events[0].text).toBe("I'll run the tests.");
  });

  it("assigns stable, unique ids", () => {
    const messages = [stdout(`${ASSISTANT_LINE}\n${ASSISTANT_LINE}\n`)];
    const events = parseSessionTranscript(messages, "claude-stream-json");
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("ignores non-stdout messages", () => {
    const messages: AgentOutputMessage[] = [
      { type: "stderr", sessionId: "s1", data: "a warning\n" },
      { type: "exit", sessionId: "s1", exitCode: 0 },
      stdout(`${ASSISTANT_LINE}\n`),
    ];
    const events = parseSessionTranscript(messages, "claude-stream-json");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("assistant");
  });
});

describe("extractUserText", () => {
  it("reads a plain-text user turn (array content)", () => {
    expect(extractUserText(USER_LINE)).toBe("Please implement feature X");
  });

  it("reads a string-content user turn", () => {
    const line = JSON.stringify({ type: "user", message: { content: "hi there" } });
    expect(extractUserText(line)).toBe("hi there");
  });

  it("returns null for a tool_result-only user message", () => {
    expect(extractUserText(TOOL_ERROR_LINE)).toBeNull();
  });

  it("returns null for non-user or malformed lines", () => {
    expect(extractUserText(ASSISTANT_LINE)).toBeNull();
    expect(extractUserText("not json")).toBeNull();
  });
});
