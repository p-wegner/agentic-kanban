import { describe, it, expect } from "vitest";
import type { SessionSummary } from "@agentic-kanban/shared";
import { buildIssueSummaryLines } from "./issue-cli-format.js";

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
