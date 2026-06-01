import { describe, expect, it } from "vitest";
import type { DisplayEvent } from "../lib/agent-output-parser.js";
import { buildTranscriptSearchEntries } from "./TerminalView.js";

describe("buildTranscriptSearchEntries", () => {
  const events: DisplayEvent[] = [
    { kind: "assistant", text: "Updated the workspace transcript renderer.", model: "claude" },
    {
      kind: "tool_use",
      id: "tool-1",
      name: "Read",
      input: JSON.stringify({ file_path: "packages/client/src/components/TerminalView.tsx" }),
      inputParsed: { file_path: "packages/client/src/components/TerminalView.tsx" },
    },
    {
      kind: "tool_result",
      toolName: "Read",
      toolUseId: "tool-1",
      output: "TerminalView contains the session transcript UI.",
      isError: false,
    },
    {
      kind: "tool_result",
      toolName: "Bash",
      toolUseId: "tool-2",
      output: "Error: test failed",
      isError: true,
    },
  ];

  it("searches assistant text and tool result text", () => {
    expect(buildTranscriptSearchEntries(events, "workspace").map((entry) => entry.event.kind)).toEqual(["assistant"]);
    expect(buildTranscriptSearchEntries(events, "session transcript").map((entry) => entry.event.kind)).toEqual(["tool_result"]);
  });

  it("filters tool calls, errors, and file path mentions when metadata is available", () => {
    expect(buildTranscriptSearchEntries(events, "", new Set(["tool_call"])).map((entry) => entry.idx)).toEqual([1]);
    expect(buildTranscriptSearchEntries(events, "", new Set(["error"])).map((entry) => entry.idx)).toEqual([3]);
    expect(buildTranscriptSearchEntries(events, "", new Set(["file"])).map((entry) => entry.idx)).toEqual([1]);
  });
});
