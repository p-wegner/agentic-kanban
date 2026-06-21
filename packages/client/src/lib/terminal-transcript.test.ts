import { describe, it, expect } from "vitest";
import {
  truncateEventsForDisplay,
  MAX_DISPLAY_EVENTS,
  buildTranscriptSearchEntries,
  eventSearchText,
  basename,
  isSkillRead,
  summarizeToolCall,
  buildDisplayEventsFromMessages,
  buildRawDisplayEvents,
  computeSubagentGrouping,
  markerColorForEvent,
  CONNECTION_STATUS_COLORS,
  CONNECTION_STATUS_LABELS,
  buildSessionDownloadText,
  buildSessionDownloadFilename,
} from "./terminal-transcript.js";
import type { DisplayEvent } from "./agent-output-parser.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

const asst = (text: string): DisplayEvent => ({ kind: "assistant", text } as DisplayEvent);
const toolUse = (name: string): DisplayEvent => ({ kind: "tool_use", name, input: "" } as DisplayEvent);

// Subagent-grouping fixtures: only the discriminant fields the logic reads.
const agentUse = (id: string, description = "", subagent_type = ""): DisplayEvent =>
  ({ kind: "tool_use", name: "Agent", id, input: "", inputParsed: { description, subagent_type } } as DisplayEvent);
const agentResult = (toolUseId: string): DisplayEvent =>
  ({ kind: "tool_result", toolName: "Agent", toolUseId, output: "", isError: false } as DisplayEvent);
const taskStarted = (toolUseId: string): DisplayEvent =>
  ({ kind: "task_started", toolUseId, taskId: toolUseId, description: "", taskType: "" } as DisplayEvent);
const omsg = (m: Partial<AgentOutputMessage> & { type: string }): AgentOutputMessage => m as AgentOutputMessage;

describe("truncateEventsForDisplay", () => {
  it("passes through below the cap", () => {
    const events = [asst("a"), asst("b")];
    expect(truncateEventsForDisplay(events)).toEqual({ events, truncated: false });
  });
  it("truncates above the cap", () => {
    const events = Array.from({ length: MAX_DISPLAY_EVENTS + 5 }, () => asst("x"));
    const out = truncateEventsForDisplay(events);
    expect(out.truncated).toBe(true);
    expect(out.events).toHaveLength(MAX_DISPLAY_EVENTS);
  });
});

describe("eventSearchText", () => {
  it("returns the text for assistant events", () => {
    expect(eventSearchText(asst("hello world"))).toBe("hello world");
  });
});

describe("buildTranscriptSearchEntries", () => {
  const events = [asst("deploy the server"), toolUse("Bash"), asst("all green")];

  it("returns all entries for an empty query", () => {
    expect(buildTranscriptSearchEntries(events, "")).toHaveLength(3);
  });
  it("filters by case-insensitive query substring", () => {
    const out = buildTranscriptSearchEntries(events, "GREEN");
    expect(out).toHaveLength(1);
    expect(out[0].idx).toBe(2);
  });
  it("filters by filter set (tool_call)", () => {
    const out = buildTranscriptSearchEntries(events, "", new Set(["tool_call"]));
    expect(out).toHaveLength(1);
    expect(out[0].event.kind).toBe("tool_use");
  });
});

describe("basename", () => {
  it("returns the last path segment across separators", () => {
    expect(basename("a/b/c.ts")).toBe("c.ts");
    expect(basename("C:\\x\\y.tsx")).toBe("y.tsx");
    expect(basename("/trailing/slash/")).toBe("slash");
  });
});

describe("isSkillRead", () => {
  it("detects a SKILL.md read and returns the skill name", () => {
    expect(isSkillRead("Read", { file_path: "repo/.claude/skills/dev-server/SKILL.md" })).toBe("dev-server");
  });
  it("returns null for non-Read or non-skill files", () => {
    expect(isSkillRead("Read", { file_path: "src/index.ts" })).toBeNull();
    expect(isSkillRead("Bash", { command: "ls" })).toBeNull();
  });
});

describe("summarizeToolCall", () => {
  it("summarizes common tools", () => {
    expect(summarizeToolCall("Read", { file_path: "a/b.ts" })).toBe("Reading b.ts");
    expect(summarizeToolCall("Read", { file_path: ".claude/skills/foo/SKILL.md" })).toBe("Loading skill: foo");
    expect(summarizeToolCall("Bash", { command: "pnpm test" })).toBe("Running: pnpm test");
    expect(summarizeToolCall("TaskUpdate", { status: "completed", subject: "X" })).toBe("Done: X");
    expect(summarizeToolCall("UnknownTool", {})).toBe("UnknownTool");
  });
});

describe("buildRawDisplayEvents", () => {
  it("maps exit to a coded line, others to their data, and drops empties", () => {
    const out = buildRawDisplayEvents([
      omsg({ type: "stdout", data: "hello" }),
      omsg({ type: "stdout", data: "" }),
      omsg({ type: "exit", exitCode: 2 }),
      omsg({ type: "exit" }),
    ]);
    expect(out).toEqual([
      { kind: "raw", text: "hello" },
      { kind: "raw", text: "Process exited with code 2" },
      { kind: "raw", text: "Process exited with code unknown" },
    ]);
  });
});

describe("buildDisplayEventsFromMessages", () => {
  it("parseOutput='false' passes through raw (delegates to buildRawDisplayEvents)", () => {
    const out = buildDisplayEventsFromMessages([omsg({ type: "stdout", data: "x" })], "false", "claude-stream-json");
    expect(out).toEqual([{ kind: "raw", text: "x" }]);
  });

  it("renders an auto-bisect result with breaking commit + failing test", () => {
    const out = buildDisplayEventsFromMessages(
      [omsg({ type: "bisect", data: JSON.stringify({ breakingCommitSha: "abc123", message: "broke it", failingTestName: "t.test.ts" }) })],
      "minimal",
      "claude-stream-json",
    );
    expect(out).toEqual([{ kind: "raw", text: "Auto-bisect result: abc123 broke it\nFailing test: t.test.ts" }]);
  });

  it("renders a status-only bisect result and falls back on invalid JSON", () => {
    expect(
      buildDisplayEventsFromMessages([omsg({ type: "bisect", data: JSON.stringify({ status: "clean" }) })], "minimal", "claude-stream-json"),
    ).toEqual([{ kind: "raw", text: "Auto-bisect result: clean" }]);
    expect(
      buildDisplayEventsFromMessages([omsg({ type: "bisect", data: "not json" })], "minimal", "claude-stream-json"),
    ).toEqual([{ kind: "raw", text: "not json" }]);
  });

  it("passes stderr and exit through as raw lines in the parse path", () => {
    const out = buildDisplayEventsFromMessages(
      [omsg({ type: "stderr", data: "boom" }), omsg({ type: "exit", exitCode: 1 })],
      "minimal",
      "claude-stream-json",
    );
    expect(out).toEqual([
      { kind: "raw", text: "boom" },
      { kind: "raw", text: "Process exited with code 1" },
    ]);
  });
});

describe("computeSubagentGrouping", () => {
  it("marks a started-but-unfinished agent active, finished one inactive", () => {
    const { activeSubagentToolUseIds } = computeSubagentGrouping([
      taskStarted("a"),
      taskStarted("b"),
      agentResult("b"),
    ]);
    expect([...activeSubagentToolUseIds]).toEqual(["a"]);
  });

  it("spans a closed agent group from its tool_use to its tool_result", () => {
    const events = [agentUse("a", "do work", "explorer"), asst("mid"), agentResult("a"), asst("after")];
    const { subagentGroups, eventToSubagent } = computeSubagentGrouping(events);
    expect(subagentGroups.get("a")).toEqual({ startIdx: 0, endIdx: 2, description: "do work", subagentType: "explorer" });
    expect(eventToSubagent.get(0)).toBe("a");
    expect(eventToSubagent.get(1)).toBe("a");
    expect(eventToSubagent.get(2)).toBe("a");
    expect(eventToSubagent.has(3)).toBe(false);
  });

  it("runs an open (unfinished) agent group to the end of the transcript", () => {
    const events = [agentUse("a"), asst("x"), asst("y")];
    const { subagentGroups } = computeSubagentGrouping(events);
    expect(subagentGroups.get("a")).toMatchObject({ startIdx: 0, endIdx: 2 });
  });
});

describe("markerColorForEvent", () => {
  it("maps each event kind to its marker color", () => {
    expect(markerColorForEvent(asst("x"))).toBe("bg-green-500");
    expect(markerColorForEvent(toolUse("Bash"))).toBe("bg-yellow-500");
    expect(markerColorForEvent(agentUse("a"))).toBe("bg-brand-500");
    expect(markerColorForEvent({ kind: "tool_result", toolName: "X", toolUseId: "1", output: "", isError: true } as DisplayEvent)).toBe("bg-red-500");
    expect(markerColorForEvent({ kind: "result", success: false } as DisplayEvent)).toBe("bg-red-400");
    expect(markerColorForEvent({ kind: "result", success: true } as DisplayEvent)).toBe("bg-emerald-400");
    expect(markerColorForEvent({ kind: "notification", key: "user" } as DisplayEvent)).toBe("bg-blue-500");
    expect(markerColorForEvent({ kind: "raw", text: "x" })).toBe("bg-gray-600");
  });
});

describe("connection status maps + download", () => {
  it("maps connection states to colors and labels", () => {
    expect(CONNECTION_STATUS_COLORS.open).toBe("bg-green-400");
    expect(CONNECTION_STATUS_LABELS.error).toBe("Connection Error");
  });
  it("builds the download filename from the session id", () => {
    expect(buildSessionDownloadFilename("s1")).toBe("session-s1.txt");
    expect(buildSessionDownloadFilename()).toBe("session-output.txt");
  });
  it("joins meaningful output for the download text", () => {
    const text = buildSessionDownloadText([omsg({ type: "stdout", data: "line one" })]);
    expect(typeof text).toBe("string");
  });
});
