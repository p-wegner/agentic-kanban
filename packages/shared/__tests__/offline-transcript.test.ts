import { describe, it, expect } from "vitest";
import { parseOfflineTranscript } from "../src/lib/offline-transcript.js";

// arch-review §2.4 (Ticket 13): the ONE offline transcript reader, built on the
// canonical per-provider stream parsers. Replaces the two hand-parsers in
// butler-transcripts.service.ts and mcp-server/tools/session-history.ts.

/** A Claude Code / SDK on-disk transcript (the shape both old parsers assumed). */
function claudeTranscript(): string[] {
  return [
    JSON.stringify({ type: "ai-title", aiTitle: "My Session", sessionId: "sess-123456789" }),
    JSON.stringify({
      type: "user",
      entrypoint: "cli",
      sessionId: "sess-123456789",
      timestamp: "2026-06-27T10:00:00.000Z",
      message: { role: "user", content: "please read the file" },
    }),
    JSON.stringify({
      type: "assistant",
      entrypoint: "cli",
      sessionId: "sess-123456789",
      timestamp: "2026-06-27T10:00:05.000Z",
      message: {
        model: "claude-opus-4",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Sure, reading it now." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    }),
  ];
}

describe("parseOfflineTranscript — Claude on-disk transcript (butler + MCP shape)", () => {
  it("extracts user text, assistant text, tool call, model, stop reason, sessionId, turns", () => {
    const t = parseOfflineTranscript(claudeTranscript(), { provider: "claude" });

    expect(t.aiTitle).toBe("My Session");
    expect(t.sessionId).toBe("sess-123456789");
    expect(t.model).toContain("claude");
    expect(t.stopReason).toBe("tool_use");
    expect(t.userTurnCount).toBe(1);
    expect(t.sessionStarted).toBe(true);
    expect(t.assistantResponded).toBe(true);
    expect(t.assistantTextCount).toBe(1);
    expect(t.hasSdkEntrypoint).toBe(true);
    expect(t.lastAssistantText).toContain("reading it now");
    expect(t.lastToolCall).toContain("Read");

    // Messages preserve the user prompt and assistant reply, in order.
    const roles = t.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(t.messages[0].text).toContain("please read the file");
    expect(t.messages[1].text).toContain("reading it now");
  });

  it("auto-detects Claude when no provider is forced", () => {
    const t = parseOfflineTranscript(claudeTranscript());
    expect(t.provider).toBe("claude");
    expect(t.messages[0].text).toContain("please read the file");
  });

  it("requireSdkEntrypoint skips non-SDK lines (only sdk-cli/cli folded)", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        // no entrypoint → not an SDK line
        sessionId: "s1",
        timestamp: "2026-06-27T10:00:00.000Z",
        message: { role: "user", content: "ignored non-sdk turn" },
      }),
      ...claudeTranscript(),
    ];
    const t = parseOfflineTranscript(lines, { provider: "claude", requireSdkEntrypoint: true });
    expect(t.messages.some((m) => m.text.includes("ignored non-sdk turn"))).toBe(false);
    expect(t.messages.some((m) => m.text.includes("please read the file"))).toBe(true);
  });

  it("tailLines bounds parsing to the last N non-empty lines", () => {
    // Only the final assistant line is parsed; the user turn is dropped.
    const t = parseOfflineTranscript(claudeTranscript(), { provider: "claude", tailLines: 1 });
    expect(t.userTurnCount).toBe(0);
    expect(t.assistantResponded).toBe(true);
  });
});

describe("parseOfflineTranscript — non-Claude providers are NOT misread as Claude", () => {
  it("classifies a Codex transcript and reads its assistant text", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-abc" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex answer" } }),
    ];
    const t = parseOfflineTranscript(lines);
    expect(t.provider).toBe("codex");
    expect(t.messages.some((m) => m.role === "assistant" && m.text.includes("codex answer"))).toBe(true);
  });

  it("classifies a Pi transcript", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "pi-xyz" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "pi answer" } }),
    ];
    const t = parseOfflineTranscript(lines);
    expect(t.provider).toBe("pi");
    expect(t.messages.some((m) => m.text.includes("pi answer"))).toBe(true);
  });

  it("classifies a content-less assistant line as Copilot", () => {
    const lines = [JSON.stringify({ type: "assistant", message: { content: "copilot answer" } })];
    const t = parseOfflineTranscript(lines);
    expect(t.provider).toBe("copilot");
  });

  it("reports an unrecognized-only transcript as 'unknown', not copilot", () => {
    const lines = [JSON.stringify({ type: "some_future_event", foo: 1 })];
    const t = parseOfflineTranscript(lines);
    expect(t.provider).toBe("unknown");
  });
});
