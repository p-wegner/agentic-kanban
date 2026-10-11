import { describe, it, expect } from "vitest";
import type { BoardStatusIssue, BoardStatusResponse } from "@agentic-kanban/shared";
import { renderStatusScreen, truncate, visibleLength } from "../cli/status-screen.js";

function issue(n: number, over: Partial<BoardStatusIssue> = {}): BoardStatusIssue {
  return {
    issueNumber: n,
    issueId: `id-${n}`,
    title: "A very long title ".repeat(12),
    priority: "medium",
    issueType: "feature",
    statusName: "In Progress",
    workspace: { id: "w", branch: "b", status: "active", workingDir: null, baseBranch: null, isDirect: false, readyForMerge: false },
    session: { id: "s", status: "running", startedAt: new Date().toISOString(), endedAt: null },
    sessionStats: null,
    diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
    conflicts: null,
    lastActivity: new Date().toISOString(),
    lastOutput: [],
    lastAgentMessage: "working on it",
    ...over,
  };
}

function status(issues: BoardStatusIssue[]): BoardStatusResponse {
  return {
    project: { id: "p", name: "proj", repoPath: "/x", defaultBranch: "master" },
    generatedAt: new Date().toISOString(),
    totals: { totalIssues: issues.length, inProgress: 1, activeWorkspaces: 1, runningSessions: 1 },
    issues,
  };
}

describe("renderStatusScreen", () => {
  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("fits 120x40 with no line wider than the terminal", () => {
    const issues = [
      ...Array.from({ length: 8 }, (_, i) => issue(i + 1)),
      ...Array.from({ length: 30 }, (_, i) =>
        issue(100 + i, { statusName: "Todo", workspace: null, session: null, diffStats: null, lastAgentMessage: null })),
    ];
    const lines = renderStatusScreen(status(issues), { cols: 120, rows: 40 });
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const l of lines) expect(visibleLength(l)).toBeLessThanOrEqual(120);
    expect(lines.join("\n")).toContain("ACTIVE (8)");
    expect(lines.join("\n")).toContain("BACKLOG 30");
    for (let n = 1; n <= 8; n++) expect(lines.join("\n")).toContain(`#${n} `);
  });

  it("lists backlog lines with --all and shows the merge lane", () => {
    const merging = issue(5, { mergeState: { bucket: "pending_merge", reason: "auto-merge-in-review", label: "auto-merge" } });
    const todo = issue(6, { statusName: "Todo", workspace: null, session: null });
    const out = renderStatusScreen(status([merging, todo]), { cols: 100, rows: 30, all: true }).join("\n");
    expect(out).toContain("MERGE (1)");
    expect(out).toContain("#6");
  });
});
