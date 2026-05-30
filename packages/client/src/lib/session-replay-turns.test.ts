import { describe, expect, it } from "vitest";
import { parseMessagesIntoTurns } from "./session-replay-turns.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

// Build a stdout AgentOutputMessage carrying one JSONL line of agent output.
function stdout(obj: unknown): AgentOutputMessage {
  return { type: "stdout", sessionId: "s1", data: JSON.stringify(obj) };
}

const exitMsg: AgentOutputMessage = { type: "exit", sessionId: "s1", exitCode: 0 };

describe("parseMessagesIntoTurns", () => {
  it("returns [] for missing / non-array input (defensive against API shape mismatch)", () => {
    // Regression guard: SessionReplay previously fetched `{ messages: [...] }` from an
    // endpoint that returns a bare array, so `data.messages` was undefined and crashed
    // the `for...of`. parseMessagesIntoTurns must tolerate that and never throw.
    expect(parseMessagesIntoTurns(undefined, "copilot-jsonl")).toEqual([]);
    expect(parseMessagesIntoTurns(null, "copilot-jsonl")).toEqual([]);
    // @ts-expect-error — exercising a malformed runtime value
    expect(parseMessagesIntoTurns({ messages: [] }, "copilot-jsonl")).toEqual([]);
  });

  it("returns [] for an empty message list", () => {
    expect(parseMessagesIntoTurns([], "copilot-jsonl")).toEqual([]);
  });

  it("groups an assistant message followed by a tool call into one turn", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "assistant_message", text: "Inspecting the file." }),
      stdout({ type: "tool_call.started", id: "t1", name: "view", input: { path: "a.ts" } }),
      stdout({ type: "tool_call.completed", id: "t1", result: "file contents", status: "completed" }),
      exitMsg,
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(1);
    expect(turns[0].index).toBe(1);
    expect(turns[0].text).toBe("Inspecting the file.");
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe("view");
    expect(turns[0].toolCalls[0].inputParsed).toEqual({ path: "a.ts" });
    expect(turns[0].toolCalls[0].result).toEqual({ output: "file contents", isError: false });
  });

  it("starts a new turn at each assistant message", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "assistant_message", text: "First." }),
      stdout({ type: "assistant_message", text: "Second." }),
      stdout({ type: "assistant_message", text: "Third." }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns.map((t) => t.text)).toEqual(["First.", "Second.", "Third."]);
    expect(turns.map((t) => t.index)).toEqual([1, 2, 3]);
  });

  it("attaches a preceding reasoning/thinking block to the next turn", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "assistant.reasoning", data: { content: "Let me think about this." } }),
      stdout({ type: "assistant.message", data: { content: "Here's my answer." } }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(1);
    expect(turns[0].thinking).toBe("Let me think about this.");
    expect(turns[0].text).toBe("Here's my answer.");
  });

  it("opens a turn from a leading tool call when there is no assistant text", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "tool_call.started", id: "t1", name: "bash", input: { command: "pnpm test" } }),
      stdout({ type: "tool_call.completed", id: "t1", result: "ok", status: "completed" }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBeUndefined();
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe("bash");
  });

  it("matches a tool result to its tool call by id, even when interleaved", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "assistant_message", text: "Running two tools." }),
      stdout({ type: "tool_call.started", id: "t1", name: "view", input: { path: "a.ts" } }),
      stdout({ type: "tool_call.started", id: "t2", name: "view", input: { path: "b.ts" } }),
      // results arrive out of order
      stdout({ type: "tool_call.completed", id: "t2", result: "B", status: "completed" }),
      stdout({ type: "tool_call.completed", id: "t1", result: "A", status: "completed" }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(1);
    const [c1, c2] = turns[0].toolCalls;
    expect(c1.id).toBe("t1");
    expect(c1.result?.output).toBe("A");
    expect(c2.id).toBe("t2");
    expect(c2.result?.output).toBe("B");
  });

  it("flags an errored tool result as isError", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "tool_call.started", id: "t1", name: "bash", input: { command: "false" } }),
      stdout({ type: "tool_call.completed", id: "t1", result: "boom", status: "failed" }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns[0].toolCalls[0].result?.isError).toBe(true);
  });

  it("accumulates token totals from result events cumulatively across turns", () => {
    const messages: AgentOutputMessage[] = [
      stdout({ type: "assistant_message", text: "Turn one." }),
      stdout({ type: "stats", usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 1, model: "m" }),
      stdout({ type: "assistant_message", text: "Turn two." }),
      stdout({ type: "stats", usage: { input_tokens: 20, output_tokens: 7 }, duration_ms: 1, model: "m" }),
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(2);
    // turn one is stamped after its result event fires
    expect(turns[0].cumulativeInputTokens).toBe(10);
    expect(turns[0].cumulativeOutputTokens).toBe(5);
    // turn two carries the running total
    expect(turns[1].cumulativeInputTokens).toBe(30);
    expect(turns[1].cumulativeOutputTokens).toBe(12);
  });

  it("ignores stderr and exit messages when building turns", () => {
    const messages: AgentOutputMessage[] = [
      { type: "stderr", sessionId: "s1", data: "a warning on stderr" },
      stdout({ type: "assistant_message", text: "Only assistant counts." }),
      exitMsg,
    ];

    const turns = parseMessagesIntoTurns(messages, "copilot-jsonl");

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Only assistant counts.");
  });

  it("returns [] when the session produced no parseable turns (interrupted/empty session)", () => {
    const messages: AgentOutputMessage[] = [
      { type: "stderr", sessionId: "s1", data: "startup noise" },
      exitMsg,
    ];

    expect(parseMessagesIntoTurns(messages, "copilot-jsonl")).toEqual([]);
  });
});
