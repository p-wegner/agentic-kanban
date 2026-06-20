import { describe, it, expect } from "vitest";
import type { SessionSummary } from "@agentic-kanban/shared";
import {
  buildIssueSummaryLines,
  buildIssueStatusLines,
  validateAttachArtifactOptions,
  formatAttachArtifactOutput,
  selectSummarySession,
  buildIssueSummaryJson,
  buildIssueStatusJson,
} from "./issue-cli-format.js";

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    overview: "",
    agentSummary: null,
    actions: [],
    keyExcerpts: [],
    errors: [],
    filesRead: [],
    filesEdited: [],
    filesWritten: [],
    commandsRun: [],
    model: "",
    tasks: [],
    rateLimits: [],
    toolUsePatterns: [],
    repeatedCommands: [],
    ...over,
  };
}

describe("buildIssueSummaryLines", () => {
  it("renders the minimal header + session line", () => {
    const lines = buildIssueSummaryLines({
      num: 7,
      title: "Fix bug",
      workspace: null,
      sessionStatus: "completed",
      duration: "1m 2s",
      stats: null,
      summary: summary(),
    });
    expect(lines).toEqual([
      "\n  #7 Fix bug",
      "  session: completed  duration: 1m 2s",
      "",
    ]);
  });

  it("renders workspace and falls back to ? duration", () => {
    const lines = buildIssueSummaryLines({
      num: 3,
      title: "T",
      workspace: { branch: "feature/x", status: "active" },
      sessionStatus: "running",
      duration: null,
      stats: null,
      summary: summary(),
    });
    expect(lines[1]).toBe("  workspace: feature/x (active)");
    expect(lines[2]).toBe("  session: running  duration: ?");
  });

  it("renders only the stat parts that pass their guards", () => {
    const lines = buildIssueSummaryLines({
      num: 1,
      title: "T",
      workspace: null,
      sessionStatus: "completed",
      duration: "5s",
      stats: { model: "opus", numTurns: 4, totalCostUsd: 1.2, inputTokens: 100, outputTokens: 50 },
      summary: summary({ model: "ignored-when-stats-model" }),
    });
    expect(lines).toContain("  model: opus  turns: 4  cost: $1.20  tokens: 100 in / 50 out");
  });

  it("omits zero-valued stat parts", () => {
    const lines = buildIssueSummaryLines({
      num: 1,
      title: "T",
      workspace: null,
      sessionStatus: "completed",
      duration: "5s",
      stats: { numTurns: 0, totalCostUsd: 0, inputTokens: 0, outputTokens: 0 },
      summary: summary({ model: "haiku" }),
    });
    // model falls back to summary.model; turns/cost/tokens guards all fail
    expect(lines).toContain("  model: haiku");
    expect(lines.some((l) => l.includes("turns:") || l.includes("cost:") || l.includes("tokens:"))).toBe(false);
  });

  it("renders agent summary across multiple indented lines", () => {
    const lines = buildIssueSummaryLines({
      num: 1, title: "T", workspace: null, sessionStatus: "completed", duration: null, stats: null,
      summary: summary({ agentSummary: "line one\nline two" }),
    });
    expect(lines).toContain("\n  Agent summary:");
    expect(lines).toContain("    line one");
    expect(lines).toContain("    line two");
  });

  it("dedups files (first-occurrence order) and tags edited/written over read", () => {
    const lines = buildIssueSummaryLines({
      num: 1, title: "T", workspace: null, sessionStatus: "completed", duration: null, stats: null,
      summary: summary({
        filesRead: ["a.ts", "b.ts"],
        filesEdited: ["b.ts"],
        filesWritten: ["c.ts"],
      }),
    });
    expect(lines).toContain("\n  Files (3):");
    expect(lines).toContain("    a.ts (read)");
    expect(lines).toContain("    b.ts (edited)");
    expect(lines).toContain("    c.ts (written)");
  });

  it("caps commands at 10 with an overflow note and errors at 5", () => {
    const cmds = Array.from({ length: 12 }, (_, i) => `cmd${i}`);
    const errs = Array.from({ length: 7 }, (_, i) => `err${i}`);
    const lines = buildIssueSummaryLines({
      num: 1, title: "T", workspace: null, sessionStatus: "completed", duration: null, stats: null,
      summary: summary({ commandsRun: cmds, errors: errs }),
    });
    expect(lines).toContain("\n  Commands (12):");
    expect(lines).toContain("    cmd9");
    expect(lines).not.toContain("    cmd10");
    expect(lines).toContain("    ... and 2 more");
    expect(lines).toContain("\n  Errors (7):");
    expect(lines).toContain("    err4");
    expect(lines).not.toContain("    err5");
  });

  it("always ends with a trailing blank line", () => {
    const lines = buildIssueSummaryLines({
      num: 1, title: "T", workspace: null, sessionStatus: "completed", duration: null, stats: null,
      summary: summary(),
    });
    expect(lines[lines.length - 1]).toBe("");
  });
});

describe("buildIssueStatusLines", () => {
  const base = {
    num: 5,
    title: "Do the thing",
    statusName: "In Progress",
    issueType: "feature" as string | null,
    workspace: null,
    session: null,
    diffStats: null,
    fileChanges: null,
    lastAgentMessage: null,
    nowMs: Date.parse("2026-06-20T12:00:00.000Z"),
  };

  it("renders header + status, defaults type to 'task' when null", () => {
    expect(buildIssueStatusLines({ ...base, issueType: null })).toEqual([
      "\n  #5 Do the thing",
      "  Status: In Progress · Type: task",
      "  No file changes.",
      "",
    ]);
  });

  it("renders a worktree workspace with provider", () => {
    const lines = buildIssueStatusLines({
      ...base,
      workspace: { id: "abcdef1234", branch: "feature/x", status: "active", isDirect: false, provider: "claude" },
    });
    expect(lines).toContain("  Workspace: abcdef12 (feature/x, worktree, active, claude)");
  });

  it("labels a direct workspace and omits provider when absent", () => {
    const lines = buildIssueStatusLines({
      ...base,
      workspace: { id: "abcdef1234", branch: "main", status: "idle", isDirect: true, provider: null },
    });
    expect(lines).toContain("  Workspace: abcdef12 (main, direct, idle)");
  });

  it("renders the session line with ago + lasted duration", () => {
    const lines = buildIssueStatusLines({
      ...base,
      session: { id: "sess1234ab", status: "completed", startedAt: "2026-06-20T11:58:00.000Z", endedAt: "2026-06-20T11:59:00.000Z" },
    });
    expect(lines).toContain("  Session:  sess1234 (completed, 2m 0s ago, lasted 1m 0s)");
  });

  it("prefers diff stats over file-change counts", () => {
    const lines = buildIssueStatusLines({
      ...base,
      diffStats: { filesChanged: 1, insertions: 10, deletions: 2 },
      fileChanges: { read: 9, edited: 9, written: 9 },
    });
    expect(lines).toContain("  Diff: 1 file, +10/-2");
    expect(lines.some((l) => l.startsWith("  Files:"))).toBe(false);
  });

  it("falls back to file-change counts when no diff stats", () => {
    const lines = buildIssueStatusLines({
      ...base,
      diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
      fileChanges: { read: 3, edited: 1, written: 0 },
    });
    expect(lines).toContain("  Files: 3 read, 1 edited");
  });

  it("truncates a long last agent message to 197 chars + ellipsis", () => {
    const long = "x".repeat(250);
    const lines = buildIssueStatusLines({ ...base, lastAgentMessage: long });
    expect(lines).toContain("\n  Last agent message:");
    const msgLine = lines.find((l) => l.startsWith("    x"))!;
    expect(msgLine).toBe("    " + "x".repeat(197) + "...");
  });
});

describe("validateAttachArtifactOptions", () => {
  it("rejects a non-positive / non-integer issue number first", () => {
    expect(validateAttachArtifactOptions("0", { type: "text", content: "x" })).toEqual({ ok: false, error: "Invalid issue number: 0" });
    expect(validateAttachArtifactOptions("abc", { type: "text", content: "x" })).toEqual({ ok: false, error: "Invalid issue number: abc" });
  });

  it("requires --type, then a valid type", () => {
    expect(validateAttachArtifactOptions("5", { content: "x" })).toEqual({ ok: false, error: "--type is required. Valid: text, link, image" });
    expect(validateAttachArtifactOptions("5", { type: "video", content: "x" })).toEqual({ ok: false, error: "Invalid type 'video'. Valid: text, link, image" });
  });

  it("requires non-empty content", () => {
    expect(validateAttachArtifactOptions("5", { type: "text" })).toEqual({ ok: false, error: "--content is required and cannot be empty." });
    expect(validateAttachArtifactOptions("5", { type: "text", content: "   " })).toEqual({ ok: false, error: "--content is required and cannot be empty." });
  });

  it("returns parsed values for valid input", () => {
    expect(validateAttachArtifactOptions("42", { type: "link", content: "https://x" })).toEqual({ ok: true, num: 42, type: "link", content: "https://x" });
  });
});

describe("formatAttachArtifactOutput", () => {
  const result = { id: "id1", issueId: "i1", workspaceId: null, type: "text", mimeType: null, caption: null };

  it("returns a single JSON line in json mode", () => {
    const lines = formatAttachArtifactOutput(result, 7, true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(result);
  });

  it("returns the human confirmation without caption", () => {
    expect(formatAttachArtifactOutput(result, 7, false)).toEqual([
      "Attached text artifact to issue #7.",
      "  id: id1",
    ]);
  });

  it("includes the caption line when present", () => {
    const lines = formatAttachArtifactOutput({ ...result, caption: "a note" }, 7, false);
    expect(lines).toContain("  caption: a note");
  });
});

describe("selectSummarySession", () => {
  const noise = (s: { status: string; noise?: boolean }) => !!s.noise;

  it("returns null for no sessions", () => {
    expect(selectSummarySession([], noise)).toBeNull();
  });

  it("prefers a completed/stopped non-noise session", () => {
    const rows = [
      { id: "a", status: "running", noise: false },
      { id: "b", status: "completed", noise: false },
    ];
    expect(selectSummarySession(rows, noise)?.id).toBe("b");
  });

  it("falls back to the first relevant session when none completed/stopped", () => {
    const rows = [
      { id: "a", status: "running", noise: false },
      { id: "b", status: "running", noise: false },
    ];
    expect(selectSummarySession(rows, noise)?.id).toBe("a");
  });

  it("uses all sessions when every one is noise", () => {
    const rows = [
      { id: "a", status: "completed", noise: true },
      { id: "b", status: "running", noise: true },
    ];
    expect(selectSummarySession(rows, noise)?.id).toBe("a");
  });
});

describe("buildIssueSummaryJson", () => {
  const session = { id: "s1", status: "completed", startedAt: "2026-06-20T10:00:00.000Z", endedAt: "2026-06-20T10:01:00.000Z" };

  it("includes workspace, session, stats (with defaults) and spreads the summary", () => {
    const json = buildIssueSummaryJson({
      issueId: "i1",
      issueNumber: 9,
      title: "T",
      workspace: { id: "w1", branch: "b", status: "active" },
      session,
      duration: "1m 0s",
      stats: { durationMs: 5, totalCostUsd: 1, inputTokens: 10, outputTokens: 5 },
      summary: summary({ model: "opus", overview: "ov" }),
    }) as any;
    expect(json.issueId).toBe("i1");
    expect(json.workspace).toEqual({ id: "w1", branch: "b", status: "active" });
    expect(json.session).toEqual({ ...session, duration: "1m 0s" });
    // numTurns defaults to 1, model falls back to summary.model, success to false
    expect(json.stats).toEqual({ durationMs: 5, totalCostUsd: 1, inputTokens: 10, outputTokens: 5, numTurns: 1, model: "opus", success: false });
    expect(json.overview).toBe("ov"); // spread from summary
  });

  it("nulls workspace and stats when absent", () => {
    const json = buildIssueSummaryJson({
      issueId: "i1", issueNumber: null, title: "T",
      workspace: null, session, duration: null, stats: null, summary: summary(),
    }) as any;
    expect(json.workspace).toBeNull();
    expect(json.stats).toBeNull();
    expect(json.issueNumber).toBeNull();
  });
});

describe("buildIssueStatusJson", () => {
  it("maps fields and nulls absent workspace/session", () => {
    const json = buildIssueStatusJson({
      issueNumber: 7, title: "T", statusName: "Done", priority: "high",
      workspace: null, session: null, lastAgentMessage: null,
      fileChanges: null, diffStats: null,
    }) as any;
    expect(json).toEqual({
      issueNumber: 7, title: "T", status: "Done", priority: "high",
      workspace: null, session: null, lastAgentMessage: null, fileChanges: null, diffStats: null,
    });
  });

  it("projects workspace + session sub-objects", () => {
    const json = buildIssueStatusJson({
      issueNumber: 1, title: "T", statusName: "In Progress", priority: null,
      workspace: { id: "w1", branch: "b", status: "active", isDirect: true, provider: "claude" },
      session: { id: "s1", status: "running", startedAt: "2026-06-20T10:00:00.000Z", endedAt: null },
      lastAgentMessage: "hi", fileChanges: { read: 1, edited: 2, written: 0 }, diffStats: null,
    }) as any;
    expect(json.workspace).toEqual({ id: "w1", branch: "b", status: "active", isDirect: true, provider: "claude" });
    expect(json.session).toEqual({ id: "s1", status: "running", startedAt: "2026-06-20T10:00:00.000Z", endedAt: null });
    expect(json.lastAgentMessage).toBe("hi");
  });
});
