import { describe, expect, it } from "vitest";
import type { DisplayEvent } from "../lib/agent-output-parser.js";
import { buildTranscriptSearchEntries, truncateEventsForDisplay, MAX_DISPLAY_EVENTS } from "./TerminalView.js";

const makeAssistant = (text: string): DisplayEvent => ({ kind: "assistant", text, model: "claude" });
const makeToolUse = (name: string, id: string, filePath?: string): DisplayEvent => ({
  kind: "tool_use",
  id,
  name,
  input: JSON.stringify(filePath ? { file_path: filePath } : {}),
  inputParsed: filePath ? { file_path: filePath } : {},
});
const makeToolResult = (toolName: string, toolUseId: string, output: string, isError = false): DisplayEvent => ({
  kind: "tool_result",
  toolName,
  toolUseId,
  output,
  isError,
});

const BASE_EVENTS: DisplayEvent[] = [
  makeAssistant("Updated the workspace transcript renderer."),
  makeToolUse("Read", "tool-1", "packages/client/src/components/TerminalView.tsx"),
  makeToolResult("Read", "tool-1", "TerminalView contains the session transcript UI.", false),
  makeToolResult("Bash", "tool-2", "Error: test failed", true),
];

describe("buildTranscriptSearchEntries", () => {
  it("returns all events for empty query and no filters", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "");
    expect(results).toHaveLength(BASE_EVENTS.length);
    expect(results.map((e) => e.idx)).toEqual([0, 1, 2, 3]);
  });

  it("returns empty array for empty input events", () => {
    expect(buildTranscriptSearchEntries([], "anything")).toHaveLength(0);
    expect(buildTranscriptSearchEntries([], "")).toHaveLength(0);
  });

  it("searches assistant text and tool result text", () => {
    expect(buildTranscriptSearchEntries(BASE_EVENTS, "workspace").map((e) => e.event.kind)).toEqual(["assistant"]);
    expect(buildTranscriptSearchEntries(BASE_EVENTS, "session transcript").map((e) => e.event.kind)).toEqual(["tool_result"]);
  });

  it("search is case-insensitive", () => {
    expect(buildTranscriptSearchEntries(BASE_EVENTS, "WORKSPACE")).toHaveLength(1);
    expect(buildTranscriptSearchEntries(BASE_EVENTS, "Workspace")).toHaveLength(1);
  });

  it("returns correct idx values matching original event positions", () => {
    // "Error" matches only BASE_EVENTS[3] (isError result with "Error: test failed")
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "Error");
    expect(results).toHaveLength(1);
    expect(results[0].idx).toBe(3);
    // "TerminalView" matches BASE_EVENTS[1] (tool_use input) and BASE_EVENTS[2] (tool_result output)
    const results2 = buildTranscriptSearchEntries(BASE_EVENTS, "TerminalView");
    expect(results2).toHaveLength(2);
    expect(results2[0].idx).toBe(1);
    expect(results2[1].idx).toBe(2);
  });

  it("filters tool calls by tool_call filter", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "", new Set(["tool_call"]));
    expect(results.map((e) => e.idx)).toEqual([1]);
  });

  it("filters errors by error filter", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "", new Set(["error"]));
    expect(results.map((e) => e.idx)).toEqual([3]);
  });

  it("filters file path mentions by file filter", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "", new Set(["file"]));
    expect(results.map((e) => e.idx)).toEqual([1]);
  });

  it("combines query and filter — only events matching both are returned", () => {
    const events: DisplayEvent[] = [
      makeAssistant("Found an error in the output."),
      makeToolResult("Bash", "t1", "Error: compilation failed", true),
      makeToolResult("Read", "t2", "No error here, just a file.", false),
    ];
    const results = buildTranscriptSearchEntries(events, "error", new Set(["error"]));
    expect(results).toHaveLength(1);
    expect(results[0].idx).toBe(1);
  });

  it("returns correct navigation counts for a query with multiple matches", () => {
    const events: DisplayEvent[] = [
      makeAssistant("First error occurred."),
      makeAssistant("Second error reported."),
      makeAssistant("Third error confirmed."),
      makeAssistant("No issues here."),
    ];
    const results = buildTranscriptSearchEntries(events, "error");
    expect(results).toHaveLength(3);
    expect(results.map((e) => e.idx)).toEqual([0, 1, 2]);
  });

  it("correctly tags assistant filter on assistant events", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "", new Set(["assistant"]));
    expect(results).toHaveLength(1);
    expect(results[0].event.kind).toBe("assistant");
  });

  it("correctly tags tool_result filter on tool_result events", () => {
    const results = buildTranscriptSearchEntries(BASE_EVENTS, "", new Set(["tool_result"]));
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.event.kind === "tool_result")).toBe(true);
  });

  it("returns no matches when query matches nothing", () => {
    expect(buildTranscriptSearchEntries(BASE_EVENTS, "xyzzy_no_match")).toHaveLength(0);
  });

  it("returns no matches when filter matches nothing", () => {
    const events: DisplayEvent[] = [makeAssistant("All good here.")];
    expect(buildTranscriptSearchEntries(events, "", new Set(["error"]))).toHaveLength(0);
  });
});

describe("truncateEventsForDisplay", () => {
  it("returns all events unchanged when under the limit", () => {
    const events = Array.from({ length: 10 }, (_, i) => makeAssistant(`msg ${i}`));
    const { events: out, truncated } = truncateEventsForDisplay(events);
    expect(out).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  it("returns all events for empty input", () => {
    const { events: out, truncated } = truncateEventsForDisplay([]);
    expect(out).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  it("returns all events when exactly at the limit", () => {
    const events = Array.from({ length: MAX_DISPLAY_EVENTS }, (_, i) => makeAssistant(`msg ${i}`));
    const { events: out, truncated } = truncateEventsForDisplay(events);
    expect(out).toHaveLength(MAX_DISPLAY_EVENTS);
    expect(truncated).toBe(false);
  });

  it("truncates and flags when exceeding the limit", () => {
    const events = Array.from({ length: MAX_DISPLAY_EVENTS + 100 }, (_, i) => makeAssistant(`msg ${i}`));
    const { events: out, truncated } = truncateEventsForDisplay(events);
    expect(out).toHaveLength(MAX_DISPLAY_EVENTS);
    expect(truncated).toBe(true);
  });

  it("returns the first MAX_DISPLAY_EVENTS events (not the last)", () => {
    const events = Array.from({ length: MAX_DISPLAY_EVENTS + 5 }, (_, i) => makeAssistant(`msg ${i}`));
    const { events: out } = truncateEventsForDisplay(events);
    expect((out[0] as Extract<DisplayEvent, { kind: "assistant" }>).text).toBe("msg 0");
    expect((out[MAX_DISPLAY_EVENTS - 1] as Extract<DisplayEvent, { kind: "assistant" }>).text).toBe(`msg ${MAX_DISPLAY_EVENTS - 1}`);
  });
});
