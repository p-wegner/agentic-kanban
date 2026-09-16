import { describe, it, expect } from "vitest";
import type { BoardStatusResponse, BoardStatusIssue } from "@agentic-kanban/shared";
import { renderTrackerFrame, ageSince } from "./tracker-render.js";

function issue(overrides: Partial<BoardStatusIssue>): BoardStatusIssue {
  return {
    issueNumber: 1,
    issueId: "issue-1",
    title: "Some ticket title",
    priority: "medium",
    issueType: "task",
    statusName: "In Progress",
    workspace: null,
    session: null,
    sessionStats: null,
    diffStats: null,
    conflicts: null,
    lastActivity: null,
    lastOutput: [],
    lastAgentMessage: null,
    attention: null,
    mergeState: null,
    ...overrides,
  };
}

function snapshot(issues: BoardStatusIssue[]): BoardStatusResponse {
  return {
    project: { id: "proj-1", name: "pantry", repoPath: "/repo", defaultBranch: "master" },
    generatedAt: "2026-09-16T12:00:00.000Z",
    totals: {
      totalIssues: issues.length,
      inProgress: issues.filter((i) => i.statusName === "In Progress").length,
      activeWorkspaces: issues.filter((i) => i.workspace && ["active", "fixing", "reviewing", "awaiting-plan-approval"].includes(i.workspace.status)).length,
      runningSessions: issues.filter((i) => i.session?.status === "running").length,
    },
    issues,
  };
}

const NOW = new Date("2026-09-16T12:10:00.000Z");

const FIXTURE = snapshot([
  issue({
    issueNumber: 101,
    title: "Ship a tracker CLI command rendering a compact live terminal dashboard",
    statusName: "In Progress",
    workspace: { id: "ws-1", branch: "feature/ak-101", status: "active", workingDir: "/repo/.worktrees/ak-101", baseBranch: "master", isDirect: false, readyForMerge: false },
    lastActivity: "2026-09-16T12:07:00.000Z",
  }),
  issue({
    issueNumber: 102,
    title: "Reviewing ticket",
    statusName: "In Review",
    workspace: { id: "ws-2", branch: "feature/ak-102", status: "reviewing", workingDir: "/repo/.worktrees/ak-102", baseBranch: "master", isDirect: false, readyForMerge: false },
    lastActivity: "2026-09-16T11:00:00.000Z",
  }),
  issue({
    issueNumber: 103,
    title: "Idle ticket, no workspace activity",
    statusName: "Todo",
    workspace: null,
  }),
  issue({
    issueNumber: 104,
    title: "Stuck ticket awaiting human input",
    statusName: "In Progress",
    workspace: { id: "ws-4", branch: "feature/ak-104", status: "idle", workingDir: "/repo/.worktrees/ak-104", baseBranch: "master", isDirect: false, readyForMerge: false },
    lastActivity: "2026-09-16T09:00:00.000Z",
    attention: { bucket: "needs_attention", reason: "idle-awaiting", label: "idle, awaiting input" },
  }),
]);

describe("renderTrackerFrame", () => {
  it("renders a header, one line per in-flight workspace, and an attention section", () => {
    const frame = renderTrackerFrame(FIXTURE, { limit: 5 }, { width: 80, now: NOW });

    // header + 2 in-flight (active, reviewing — idle #104 is NOT in-flight) + attention marker + 1 attention row
    expect(frame.lines).toHaveLength(5);
    expect(frame.lines[0]).toContain("pantry");
    expect(frame.lines[0]).toContain("WIP 2/5");
    expect(frame.lines[1]).toContain("#101");
    expect(frame.lines[2]).toContain("#102");
    expect(frame.lines[3]).toBe("-- attention --");
    expect(frame.lines[4]).toContain("#104");
    expect(frame.text).toBe(frame.lines.join("\n"));
  });

  it("never exceeds the requested width on any line", () => {
    for (const width of [20, 40, 80, 120]) {
      const frame = renderTrackerFrame(FIXTURE, { limit: 5 }, { width, now: NOW });
      for (const line of frame.lines) {
        expect(line.length).toBeLessThanOrEqual(Math.max(20, width));
      }
    }
  });

  it("truncates a long title with an ellipsis rather than wrapping", () => {
    const frame = renderTrackerFrame(FIXTURE, { limit: 5 }, { width: 30, now: NOW });
    const line101 = frame.lines.find((l) => l.includes("#101"));
    expect(line101).toBeDefined();
    expect(line101!.length).toBeLessThanOrEqual(30);
    expect(line101).toContain("…");
  });

  it("keeps the line count stable across widths (only content is truncated, not dropped)", () => {
    const counts = [20, 40, 80, 120].map((width) => renderTrackerFrame(FIXTURE, { limit: 5 }, { width, now: NOW }).lines.length);
    expect(new Set(counts).size).toBe(1);
  });

  it("prints a placeholder line when nothing is in-flight and omits the attention section when clean", () => {
    const idleOnly = snapshot([issue({ issueNumber: 1, statusName: "Todo", workspace: null })]);
    const frame = renderTrackerFrame(idleOnly, { limit: 3 }, { width: 80, now: NOW });
    expect(frame.lines).toHaveLength(2);
    expect(frame.lines[1]).toContain("no in-flight workspaces");
  });

  it("falls back to width 80 when no width is given, and floors an unreasonably narrow one at 20", () => {
    const noWidth = renderTrackerFrame(FIXTURE, { limit: 5 }, { now: NOW });
    expect(noWidth.lines[0].length).toBeLessThanOrEqual(80);

    const tiny = renderTrackerFrame(FIXTURE, { limit: 5 }, { width: 1, now: NOW });
    for (const line of tiny.lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("ageSince", () => {
  it("formats seconds, minutes, hours+minutes, and days+hours", () => {
    expect(ageSince("2026-09-16T12:09:30.000Z", NOW)).toBe("30s");
    expect(ageSince("2026-09-16T12:05:00.000Z", NOW)).toBe("5m");
    expect(ageSince("2026-09-16T09:07:00.000Z", NOW)).toBe("3h3m");
    expect(ageSince("2026-09-14T10:00:00.000Z", NOW)).toBe("2d2h");
  });

  it("returns a placeholder for missing or invalid timestamps", () => {
    expect(ageSince(null, NOW)).toBe("-");
    expect(ageSince(undefined, NOW)).toBe("-");
    expect(ageSince("not-a-date", NOW)).toBe("-");
  });
});
