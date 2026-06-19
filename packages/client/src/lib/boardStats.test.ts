import { describe, it, expect } from "vitest";
import type { IssueWithStatus, StatusWithIssues, MainWorkspaceInfo } from "@agentic-kanban/shared";
import { computeBoardStats } from "./boardStats.js";

function issue(main?: Partial<MainWorkspaceInfo>): IssueWithStatus {
  return {
    workspaceSummary: main ? { total: 1, active: 0, idle: 0, closed: 0, branches: [], main: main as MainWorkspaceInfo } : undefined,
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

  it("counts only active/reviewing main workspaces as active agents", () => {
    const active = [
      col("In Progress", 4, [
        issue({ status: "active" }),
        issue({ status: "reviewing" }),
        issue({ status: "idle" }),
        issue(), // no workspace
      ]),
    ];
    const s = computeBoardStats(active, []);
    expect(s.activeWorkspaces).toBe(2);
  });

  it("tallies profiles, preferring tagged profile.name over legacy claudeProfile", () => {
    const active = [
      col("In Progress", 3, [
        issue({ status: "active", profile: { provider: "claude", name: "anth" } }),
        issue({ status: "reviewing", profile: { provider: "claude", name: "anth" } }),
        issue({ status: "idle", claudeProfile: "legacy" }),
      ]),
    ];
    const s = computeBoardStats(active, []);
    expect(s.profileCounts.get("anth")).toBe(2);
    expect(s.profileCounts.get("legacy")).toBe(1);
  });

  it("ignores archive-column issues when counting active agents and profiles", () => {
    const archive = [col("Done", 1, [issue({ status: "active", claudeProfile: "x" })])];
    const s = computeBoardStats([], archive);
    expect(s.activeWorkspaces).toBe(0);
    expect(s.profileCounts.size).toBe(0);
  });
});
