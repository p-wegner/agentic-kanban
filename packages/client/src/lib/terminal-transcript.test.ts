import { describe, it, expect } from "vitest";
import {
  truncateEventsForDisplay,
  MAX_DISPLAY_EVENTS,
  buildTranscriptSearchEntries,
  eventSearchText,
  basename,
  isSkillRead,
  summarizeToolCall,
} from "./terminal-transcript.js";
import type { DisplayEvent } from "./agent-output-parser.js";

const asst = (text: string): DisplayEvent => ({ kind: "assistant", text } as DisplayEvent);
const toolUse = (name: string): DisplayEvent => ({ kind: "tool_use", name, input: "" } as DisplayEvent);

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
