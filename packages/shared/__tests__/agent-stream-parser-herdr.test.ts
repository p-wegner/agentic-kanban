import { describe, expect, it } from "vitest";

import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
} from "../src/lib/agent-stream-parser.js";

/**
 * Herdr never runs a model itself — it relays the driven agent CLI's own stream
 * verbatim, so herdr's wire format is Claude's (the default driven agent, and what
 * the mock-agent test harness emits regardless of provider) — NOT Pi's, despite the
 * launch-config shape mirroring Pi's `--mode json -p` invocation. This pins that the
 * "herdr" dispatch branch parses Claude-shaped events identically to "claude" (#1145),
 * catching a regression back to the Pi fallback #1144 shipped with.
 */
describe("herdr stream parser dispatch (#1145)", () => {
  const parseAs = (provider: "claude" | "herdr", obj: unknown) =>
    parseAgentStreamLine(provider, JSON.stringify(obj), createAgentStreamParseContext());

  it("parses a system/init event the same as claude", () => {
    const event = { type: "system", subtype: "init", session_id: "s1", model: "mock-claude-opus-4", cwd: "/repo", tools: ["Read"] };
    expect(parseAs("herdr", event)).toEqual(parseAs("claude", event));
  });

  it("parses an assistant text event the same as claude", () => {
    const event = {
      type: "assistant",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello from the pane" }],
        model: "mock-claude-opus-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const parsed = parseAs("herdr", event);
    expect(parsed).toEqual(parseAs("claude", event));
    expect(parsed?.assistantText).toBe("hello from the pane");
  });

  it("parses a result event the same as claude, including error results", () => {
    const okResult = { type: "result", subtype: "success", is_error: false, duration_ms: 10, num_turns: 1, result: "done", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 } };
    expect(parseAs("herdr", okResult)).toEqual(parseAs("claude", okResult));

    const errorResult = { ...okResult, subtype: "error", is_error: true, result: "boom" };
    expect(parseAs("herdr", errorResult)).toEqual(parseAs("claude", errorResult));
  });

  it("does NOT parse herdr events as pi (regression guard against the #1144 fallback)", () => {
    // A Pi-shaped "session" event is meaningless to the Claude parser and must not
    // be silently accepted — this is what would happen if herdr's case reverted to
    // parsePiEvent, since Pi's "session" event carries no `type: system` field the
    // Claude parser recognizes.
    const piShapedEvent = { type: "session", id: "p1", cwd: "/repo" };
    expect(parseAs("herdr", piShapedEvent)).toBeUndefined();
  });
});
