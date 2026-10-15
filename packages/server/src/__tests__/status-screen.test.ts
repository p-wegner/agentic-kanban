import { describe, it, expect } from "vitest";
import type { BoardStatusIssue, BoardStatusResponse } from "@agentic-kanban/shared";
import { renderStatusScreen, consoleUnavailableNotice, truncate, visibleLength } from "../cli/status-screen.js";

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

describe("console fallback (#1477)", () => {
  it("names why the console could not be built, in the frame", () => {
    const notice = consoleUnavailableNotice(new Error("GET /api/projects/active/status timed out after 15000 ms"));
    const out = renderStatusScreen(status([issue(1)]), { cols: 160, rows: 30, notice }).join("\n");
    expect(out).toContain("console unavailable: GET /api/projects/active/status timed out after 15000 ms; showing the local DB view");
  });

  it("never calls a worker's session local", () => {
    const base = new Date().toISOString();
    const onWorker = issue(2, { session: { id: "s", status: "running", startedAt: base, endedAt: null, workerId: "worker-abcdef123" } });
    const unlandedOnly = issue(3, { remoteUnlanded: { workerId: "", sessionId: "s", label: "x" } });
    const mine = issue(4);
    const lines = renderStatusScreen(status([onWorker, unlandedOnly, mine]), { cols: 160, rows: 30 });
    const row = (n: number) => lines.find((l) => l.startsWith(`#${n} `)) ?? "";
    expect(row(2)).toContain("running @worker-a");
    expect(row(2)).not.toContain("local");
    expect(row(3)).toContain("running remote");
    expect(row(4)).toContain("running local");
  });
});

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

  it("lists an In Progress issue with an idle workspace under ACTIVE and counts it in ws", () => {
    const idle = issue(7, {
      workspace: { id: "w", branch: "b", status: "idle", workingDir: null, baseBranch: null, isDirect: false, readyForMerge: false },
      session: { id: "s", status: "stopped", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
    });
    const out = renderStatusScreen(status([idle]), { cols: 120, rows: 30, onlineWorkers: 1 }).join("\n");
    expect(out).toContain("ACTIVE (1)");
    expect(out).toContain("#7");
    expect(out).toContain("stopped");
    expect(out).toContain("1 ws, 0 running | workers 1");
  });

  it("lists backlog lines with --all and shows the merge lane", () => {
    const merging = issue(5, { mergeState: { bucket: "pending_merge", reason: "auto-merge-in-review", label: "auto-merge" } });
    const todo = issue(6, { statusName: "Todo", workspace: null, session: null });
    const out = renderStatusScreen(status([merging, todo]), { cols: 100, rows: 30, all: true }).join("\n");
    expect(out).toContain("MERGE (1)");
    expect(out).toContain("#6");
  });
});
