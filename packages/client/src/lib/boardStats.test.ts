import { describe, it, expect } from "vitest";
import type { IssueWithStatus, StatusWithIssues, MainWorkspaceInfo } from "@agentic-kanban/shared";
import {
  computeAgentActivity,
  computeBoardStats,
  describeAgentActivity,
  formatAgentKinds,
  formatAgentsRunning,
  formatTicketFlow,
} from "./boardStats.js";

let wsCounter = 0;
function issue(main?: Partial<MainWorkspaceInfo>): IssueWithStatus {
  wsCounter++;
  return {
    id: `i-${wsCounter}`,
    workspaceSummary: main
      ? { total: 1, active: 0, idle: 0, closed: 0, branches: [], main: { id: `ws-${wsCounter}`, ...main } as MainWorkspaceInfo }
      : undefined,
  } as IssueWithStatus;
}

function col(name: string, count: number, issues: IssueWithStatus[] = []): StatusWithIssues {
  return { id: name, name, projectId: "p", sortOrder: 0, issues, count } as StatusWithIssues;
}

describe("computeBoardStats", () => {
  it("sums active/archive totals and concatenates columns in order", () => {
    const active = [col("Todo", 3), col("In Progress", 2)];
    const archive = [col("Done", 5), col("Cancelled", 1)];
    const s = computeBoardStats(active, archive);
    expect(s.totalActive).toBe(5);
    expect(s.totalArchive).toBe(6);
    expect(s.total).toBe(11);
    expect(s.allColumns.map((c) => c.name)).toEqual(["Todo", "In Progress", "Done", "Cancelled"]);
  });

  it("computes completion against the non-cancelled total", () => {
    // 5 done of (11 total - 1 cancelled) = 5/10 = 50%
    const s = computeBoardStats([col("Todo", 5)], [col("Done", 5), col("Cancelled", 1)]);
    expect(s.doneCount).toBe(5);
    expect(s.cancelledCount).toBe(1);
    expect(s.nonCancelledTotal).toBe(10);
    expect(s.completionPct).toBe(50);
  });

  it("reports 0% completion on an empty board (no divide-by-zero)", () => {
    const s = computeBoardStats([], []);
    expect(s.total).toBe(0);
    expect(s.completionPct).toBe(0);
  });

  it("ticket flow lists open columns with tickets, in board order, one label per column", () => {
    const s = computeBoardStats([col("Todo", 3), col("In Progress", 0), col("In Review", 6)], [col("Done", 9)]);
    expect(s.ticketFlow.map((c) => [c.label, c.count])).toEqual([["todo", 3], ["in review", 6]]);
    expect(formatTicketFlow(s.ticketFlow)).toBe("3 todo · 6 in review");
    expect(formatTicketFlow([])).toBe("no open tickets");
  });
});

describe("computeAgentActivity (#1162)", () => {
  it("counts building, reviewing and fixing agents as running; idle, blocked, errored and closed are not", () => {
    const a = computeAgentActivity([
      col("In Progress", 6, [
        issue({ status: "active" }),
        issue({ status: "idle" }),
        issue({ status: "blocked" }),
        issue({ status: "error" }),
        issue({ status: "closed" }),
        issue(), // no workspace
      ]),
      col("In Review", 2, [issue({ status: "reviewing" }), issue({ status: "fixing" })]),
    ]);
    expect(a.running).toBe(3);
    expect(a.byKind).toEqual({ building: 1, reviewing: 1, fixing: 1 });
    expect(formatAgentKinds(a.byKind)).toBe("1 building · 1 reviewing · 1 fix-and-merge");
  });

  it("the live bug: idle workspaces on a profile are NOT counted for that profile", () => {
    // 10 open tickets carry an anth workspace and 1 is running; the old badge said "anth 10".
    const anth = { provider: "claude", name: "anth" } as MainWorkspaceInfo["profile"];
    const tickets = [issue({ status: "active", profile: anth }), ...Array.from({ length: 9 }, () => issue({ status: "idle", profile: anth }))];
    const a = computeAgentActivity([col("In Progress", 10, tickets)]);
    expect(a.running).toBe(1);
    expect(a.byProfile).toEqual([{ profile: "anth", count: 1 }]);
    expect(describeAgentActivity(a)).toContain("By profile: anth 1");
  });

  it("a fix-and-merge agent on an In Review ticket is running but outside In Progress, so it uses no WIP slot", () => {
    const a = computeAgentActivity([col("In Progress", 1, [issue({ status: "idle" })]), col("In Review", 1, [issue({ status: "fixing" })])]);
    expect(a.running).toBe(1);
    expect(a.outsideInProgress).toBe(1);
    expect(describeAgentActivity(a)).toContain("so not in WIP");
  });

  it("prefers the tagged profile over legacy claudeProfile and sorts profiles by count", () => {
    const team = { provider: "claude", name: "team5x" } as MainWorkspaceInfo["profile"];
    const a = computeAgentActivity([
      col("In Progress", 4, [
        issue({ status: "active", claudeProfile: "legacy" }),
        issue({ status: "active", profile: team }),
        issue({ status: "fixing", profile: team }),
        issue({ status: "active", claudeProfile: "ignored", profile: team }),
      ]),
    ]);
    expect(a.byProfile).toEqual([{ profile: "team5x", count: 3 }, { profile: "legacy", count: 1 }]);
  });

  it("counts a workspace once even when ticket-group members alias the lead's summary", () => {
    const lead = issue({ status: "active" });
    const member = { ...lead, id: "member" } as IssueWithStatus;
    const a = computeAgentActivity([col("In Progress", 1, [lead]), col("In Review", 1, [member])]);
    expect(a.running).toBe(1);
  });

  it("counts agents on archive columns too (a ticket moved while its agent still runs)", () => {
    const s = computeBoardStats([], [col("Done", 1, [issue({ status: "fixing" })])]);
    expect(s.agents.running).toBe(1);
  });

  it("formats the headline with one word for one count", () => {
    expect(formatAgentsRunning(0)).toBe("no agents running");
    expect(formatAgentsRunning(1)).toBe("1 agent running");
    expect(formatAgentsRunning(4)).toBe("4 agents running");
  });
});
