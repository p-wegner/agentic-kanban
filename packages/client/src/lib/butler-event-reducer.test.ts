import { describe, it, expect } from "vitest";
import {
  reduceButlerEvent,
  emptyAssistantBuf,
  formatToolLabel,
  type ButlerChatState,
  type ReducerDeps,
} from "./butler-event-reducer.js";

// Deterministic deps: monotonic now, sequential rand.
function deps(): ReducerDeps {
  let t = 1000;
  let r = 0;
  return { now: () => ++t, rand: () => `r${++r}` };
}

function state(over: Partial<ButlerChatState> = {}): ButlerChatState {
  return {
    chatMessages: [],
    butlerState: null,
    contextTokens: 0,
    model: undefined,
    contextWindow: undefined,
    mcpConnected: undefined,
    sending: false,
    ...over,
  };
}

describe("reduceButlerEvent — scalar events", () => {
  it("session sets active butlerState", () => {
    const { state: s } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "session", sessionId: "abc" }, deps());
    expect(s.butlerState).toEqual({ active: true, sessionId: "abc" });
  });

  it("usage sets contextTokens", () => {
    const { state: s } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "usage", contextTokens: 4200 }, deps());
    expect(s.contextTokens).toBe(4200);
  });

  it("meta only overwrites provided fields", () => {
    const start = state({ model: "old", contextWindow: 100, mcpConnected: true });
    const { state: s } = reduceButlerEvent(start, emptyAssistantBuf(), { type: "meta", model: "new" }, deps());
    expect(s.model).toBe("new");
    expect(s.contextWindow).toBe(100); // untouched
    expect(s.mcpConnected).toBe(true); // untouched
  });

  it("meta respects mcpConnected:false (defined but falsy)", () => {
    const { state: s } = reduceButlerEvent(state({ mcpConnected: true }), emptyAssistantBuf(), { type: "meta", mcpConnected: false }, deps());
    expect(s.mcpConnected).toBe(false);
  });

  it("turn-start sets sending and clears the buffer", () => {
    const { state: s, buf } = reduceButlerEvent(state({ sending: false }), { buf: "stale", msgId: "x", textSeen: true }, { type: "turn-start" }, deps());
    expect(s.sending).toBe(true);
    expect(buf).toEqual({ buf: "", msgId: null, textSeen: false });
  });

  it("ready/unknown is a no-op (same references)", () => {
    const start = state();
    const b = emptyAssistantBuf();
    const out = reduceButlerEvent(start, b, { type: "ready" }, deps());
    expect(out.state).toBe(start);
    expect(out.buf).toBe(b);
  });
});

describe("reduceButlerEvent — user messages", () => {
  it("appends a user message", () => {
    const { state: s } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "user", text: "hi" }, deps());
    expect(s.chatMessages).toHaveLength(1);
    expect(s.chatMessages[0]).toMatchObject({ role: "user", text: "hi" });
  });

  it("dedupes a user message seen in the last 4", () => {
    const start = state({ chatMessages: [{ id: "u1", role: "user", text: "dup", ts: 1 }] });
    const out = reduceButlerEvent(start, emptyAssistantBuf(), { type: "user", text: "dup" }, deps());
    expect(out.state).toBe(start); // no change
  });

  it("does NOT dedupe when the match is older than 4 messages", () => {
    const msgs = [
      { id: "u1", role: "user" as const, text: "dup", ts: 1 },
      { id: "a", role: "assistant" as const, text: "1", ts: 2 },
      { id: "b", role: "assistant" as const, text: "2", ts: 3 },
      { id: "c", role: "assistant" as const, text: "3", ts: 4 },
      { id: "d", role: "assistant" as const, text: "4", ts: 5 },
    ];
    const { state: s } = reduceButlerEvent(state({ chatMessages: msgs }), emptyAssistantBuf(), { type: "user", text: "dup" }, deps());
    expect(s.chatMessages).toHaveLength(6);
  });
});

describe("reduceButlerEvent — streamed assistant text", () => {
  it("accumulates deltas into a single message with a stable id", () => {
    const d = deps();
    let s = state();
    let buf = emptyAssistantBuf();
    ({ state: s, buf } = reduceButlerEvent(s, buf, { type: "text", text: "Hel" }, d));
    ({ state: s, buf } = reduceButlerEvent(s, buf, { type: "text", text: "lo" }, d));
    expect(s.chatMessages).toHaveLength(1);
    expect(s.chatMessages[0]).toMatchObject({ role: "assistant", text: "Hello" });
    expect(buf.buf).toBe("Hello");
    expect(buf.textSeen).toBe(true);
  });

  it("ignores empty deltas", () => {
    const start = state();
    const out = reduceButlerEvent(start, emptyAssistantBuf(), { type: "text", text: "" }, deps());
    expect(out.state).toBe(start);
  });
});

describe("reduceButlerEvent — tool calls", () => {
  it("appends a pending tool message keyed by toolId and resets text run but keeps textSeen", () => {
    const buf = { buf: "partial", msgId: "asst-1", textSeen: true };
    const { state: s, buf: nb } = reduceButlerEvent(state(), buf, { type: "tool", name: "Read", toolId: "t1", input: { file_path: "x" } }, deps());
    expect(s.chatMessages[0]).toMatchObject({ id: "tool-t1", role: "tool", text: "Reading a file", tool: { name: "Read", status: "pending" } });
    expect(nb).toEqual({ buf: "", msgId: null, textSeen: true });
  });

  it("tool-result settles the matching pending tool by id", () => {
    const start = state({ chatMessages: [{ id: "tool-t1", role: "tool", text: "Reading a file", ts: 1, tool: { name: "Read", status: "pending" } }] });
    const { state: s } = reduceButlerEvent(start, emptyAssistantBuf(), { type: "tool-result", toolId: "t1", output: "done!", isError: false }, deps());
    expect(s.chatMessages[0].tool).toMatchObject({ status: "done", output: "done!" });
  });

  it("tool-result without toolId settles the last pending tool; isError -> error", () => {
    const start = state({ chatMessages: [
      { id: "tool-a", role: "tool", text: "t", ts: 1, tool: { name: "Bash", status: "done" } },
      { id: "tool-b", role: "tool", text: "t", ts: 2, tool: { name: "Bash", status: "pending" } },
    ] });
    const { state: s } = reduceButlerEvent(start, emptyAssistantBuf(), { type: "tool-result", isError: true }, deps());
    expect(s.chatMessages[1].tool?.status).toBe("error");
    expect(s.chatMessages[0].tool?.status).toBe("done"); // untouched
  });

  it("tool-result with no matching tool is a no-op", () => {
    const start = state({ chatMessages: [{ id: "x", role: "assistant", text: "hi", ts: 1 }] });
    const out = reduceButlerEvent(start, emptyAssistantBuf(), { type: "tool-result", toolId: "missing" }, deps());
    expect(out.state).toBe(start);
  });
});

describe("reduceButlerEvent — result / error terminal events", () => {
  it("result appends final text only when none was streamed (textSeen=false)", () => {
    const { state: s, buf } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "result", text: "Final answer" }, deps());
    expect(s.chatMessages).toHaveLength(1);
    expect(s.chatMessages[0]).toMatchObject({ role: "assistant", text: "Final answer" });
    expect(s.sending).toBe(false);
    expect(buf).toEqual(emptyAssistantBuf());
  });

  it("result does NOT duplicate text already streamed (textSeen=true)", () => {
    const streamed = { buf: "Final answer", msgId: "asst-1", textSeen: true };
    const start = state({ chatMessages: [{ id: "asst-1", role: "assistant", text: "Final answer", ts: 1 }] });
    const { state: s } = reduceButlerEvent(start, streamed, { type: "result", text: "Final answer" }, deps());
    expect(s.chatMessages).toHaveLength(1); // no extra message
  });

  it("result with isError adds an activity error line", () => {
    const { state: s } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "result", text: "boom", isError: true }, deps());
    expect(s.chatMessages[0]).toMatchObject({ role: "activity", text: "Error: boom" });
  });

  it("result settles any pending tools and clears sending", () => {
    const start = state({ sending: true, chatMessages: [{ id: "tool-a", role: "tool", text: "t", ts: 1, tool: { name: "Bash", status: "pending" } }] });
    const { state: s } = reduceButlerEvent(start, emptyAssistantBuf(), { type: "result" }, deps());
    expect(s.chatMessages[0].tool?.status).toBe("done");
    expect(s.sending).toBe(false);
  });

  it("error appends an error activity line, clears sending, settles tools", () => {
    const start = state({ sending: true, chatMessages: [{ id: "tool-a", role: "tool", text: "t", ts: 1, tool: { name: "Bash", status: "pending" } }] });
    const { state: s } = reduceButlerEvent(start, emptyAssistantBuf(), { type: "error", message: "kaboom" }, deps());
    expect(s.chatMessages.at(-1)).toMatchObject({ role: "activity", text: "Error: kaboom" });
    expect(s.chatMessages[0].tool?.status).toBe("done");
    expect(s.sending).toBe(false);
  });
});

describe("formatToolLabel", () => {
  it("maps known tools and strips mcp prefixes", () => {
    expect(formatToolLabel("Read")).toBe("Reading a file");
    expect(formatToolLabel("Bash")).toBe("Running a command");
    expect(formatToolLabel("mcp__agentic-kanban__create_issue")).toBe("create issue");
  });
});

describe("reduceButlerEvent — immutability", () => {
  it("never mutates the input state or buffer", () => {
    const start = state({ chatMessages: [{ id: "a", role: "assistant", text: "x", ts: 1 }] });
    const snapshot = structuredClone(start);
    const buf = emptyAssistantBuf();
    reduceButlerEvent(start, buf, { type: "text", text: "y" }, deps());
    expect(start).toEqual(snapshot);
    expect(buf).toEqual(emptyAssistantBuf());
  });
});

// ── AskUserQuestion (#459/#460) ──────────────────────────────────────────────
// The butler's structured question arrives as its own `question` event and is
// rendered as a card, not as a tool call. Three things must hold: the card appears
// once, it flips to read-only when the server resolves it, and the generic tool card
// for AskUserQuestion never appears alongside it.

const QUESTIONS = [{
  question: "Which colour do you prefer?",
  header: "Colour",
  multiSelect: false,
  options: [{ label: "Blue", description: "The colour blue." }, { label: "Green" }],
}];

describe("reduceButlerEvent — AskUserQuestion", () => {
  it("appends an answerable question card", () => {
    const { state: s } = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "question", askId: "a1", questions: QUESTIONS }, deps());
    expect(s.chatMessages).toHaveLength(1);
    expect(s.chatMessages[0].role).toBe("question");
    expect(s.chatMessages[0].question).toEqual({ askId: "a1", questions: QUESTIONS });
    expect(s.chatMessages[0].question?.resolved).toBeUndefined();
  });

  it("is idempotent — a replayed question event does not duplicate the card", () => {
    const d = deps();
    const first = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "question", askId: "a1", questions: QUESTIONS }, d);
    const second = reduceButlerEvent(first.state, first.buf, { type: "question", askId: "a1", questions: QUESTIONS }, d);
    expect(second.state.chatMessages).toHaveLength(1);
  });

  it("question-resolved flips the card to read-only with the answers", () => {
    const d = deps();
    const asked = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "question", askId: "a1", questions: QUESTIONS }, d);
    const answers = [{ question: "Which colour do you prefer?", header: "Colour", answers: ["Green"] }];
    const { state: s } = reduceButlerEvent(asked.state, asked.buf, { type: "question-resolved", askId: "a1", answers }, d);
    expect(s.chatMessages[0].question?.resolved).toEqual({ answers, reason: undefined });
  });

  it("question-resolved carries the denial reason when nobody answered", () => {
    const d = deps();
    const asked = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "question", askId: "a1", questions: QUESTIONS }, d);
    const { state: s } = reduceButlerEvent(asked.state, asked.buf, { type: "question-resolved", askId: "a1", reason: "timeout" }, d);
    expect(s.chatMessages[0].question?.resolved).toEqual({ answers: undefined, reason: "timeout" });
  });

  it("ignores a resolution for an unknown askId and never re-resolves", () => {
    const d = deps();
    const asked = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "question", askId: "a1", questions: QUESTIONS }, d);
    const orphan = reduceButlerEvent(asked.state, asked.buf, { type: "question-resolved", askId: "other", reason: "timeout" }, d);
    expect(orphan.state).toBe(asked.state);
    const answers = [{ question: "Which colour do you prefer?", header: "Colour", answers: ["Green"] }];
    const once = reduceButlerEvent(asked.state, asked.buf, { type: "question-resolved", askId: "a1", answers }, d);
    const twice = reduceButlerEvent(once.state, once.buf, { type: "question-resolved", askId: "a1", reason: "timeout" }, d);
    expect(twice.state).toBe(once.state);
  });

  it("renders no generic tool card for AskUserQuestion and keeps the text run intact", () => {
    // The SDK dispatches the assistant message carrying this tool_use only AFTER
    // canUseTool resolved — i.e. mid-way through the reply that follows the answer.
    // Resetting the buffer there used to split that reply into two bubbles.
    const d = deps();
    const streaming = reduceButlerEvent(state(), emptyAssistantBuf(), { type: "text", text: "P" }, d);
    const withTool = reduceButlerEvent(streaming.state, streaming.buf, { type: "tool", name: "AskUserQuestion", toolId: "t1" }, d);
    const done = reduceButlerEvent(withTool.state, withTool.buf, { type: "text", text: "ICKED=Green" }, d);
    expect(done.state.chatMessages).toHaveLength(1);
    expect(done.state.chatMessages[0].text).toBe("PICKED=Green");
    expect(done.state.chatMessages.some((m) => m.role === "tool")).toBe(false);
  });
});
