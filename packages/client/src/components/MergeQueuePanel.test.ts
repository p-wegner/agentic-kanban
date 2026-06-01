import { describe, expect, it } from "vitest";
import { buildMergeQueueItems, computeMergeConflictRisk } from "./MergeQueuePanel.js";
import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";

function workspace(overrides: Partial<MainWorkspaceInfo>): MainWorkspaceInfo {
  return {
    id: `ws-${overrides.branch ?? "branch"}`,
    branch: overrides.branch ?? "feature/test",
    workingDir: null,
    status: "idle",
    readyForMerge: false,
    claudeProfile: null,
    profile: null,
    model: null,
    agentCommand: null,
    ...overrides,
  };
}

function issue(title: string, workspaceInfo: MainWorkspaceInfo, updatedAt: string): IssueWithStatus {
  return {
    id: `issue-${title}`,
    issueNumber: Number(title.match(/\d+/)?.[0] ?? 1),
    title,
    description: null,
    priority: "medium",
    issueType: "feature",
    sortOrder: 0,
    statusId: "status-review",
    projectId: "project-1",
    createdAt: updatedAt,
    updatedAt,
    statusChangedAt: updatedAt,
    statusName: "In Review",
    workspaceSummary: {
      total: 1,
      active: 0,
      idle: 1,
      closed: 0,
      branches: [workspaceInfo.branch],
      main: workspaceInfo,
    },
  };
}

function columns(issues: IssueWithStatus[]): StatusWithIssues[] {
  return [
    { id: "todo", name: "Todo", projectId: "project-1", sortOrder: 0, issues: [] },
    { id: "review", name: "In Review", projectId: "project-1", sortOrder: 1, issues },
  ];
}

describe("merge queue ordering", () => {
  it("sorts ready workspaces before gated, then by lower conflict risk and older age", () => {
    const older = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const readyRisky = issue("ready risky 1", workspace({
      id: "ready-risky",
      branch: "feature/ready-risky",
      readyForMerge: true,
      lastSessionAt: newer,
      diffStats: { filesChanged: 12, insertions: 500, deletions: 80 },
    }), newer);
    const readyCleanOlder = issue("ready clean older 2", workspace({
      id: "ready-clean-older",
      branch: "feature/ready-clean-older",
      readyForMerge: true,
      lastSessionAt: older,
      diffStats: { filesChanged: 1, insertions: 10, deletions: 0 },
    }), older);
    const readyCleanNewer = issue("ready clean newer 3", workspace({
      id: "ready-clean-newer",
      branch: "feature/ready-clean-newer",
      readyForMerge: true,
      lastSessionAt: newer,
      diffStats: { filesChanged: 1, insertions: 10, deletions: 0 },
    }), newer);
    const gatedClean = issue("gated clean 4", workspace({
      id: "gated-clean",
      branch: "feature/gated-clean",
      readyForMerge: false,
      lastSessionAt: older,
      diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    }), older);

    const ordered = buildMergeQueueItems(columns([gatedClean, readyRisky, readyCleanNewer, readyCleanOlder]));

    expect(ordered.map((item) => item.workspace.id)).toEqual([
      "ready-clean-older",
      "ready-clean-newer",
      "ready-risky",
      "gated-clean",
    ]);
  });

  it("treats cached merge conflicts as the highest risk", () => {
    const risk = computeMergeConflictRisk(workspace({
      conflicts: { hasConflicts: true, conflictingFiles: ["src/a.ts", "src/b.ts"] },
      diffStats: { filesChanged: 1, insertions: 1, deletions: 1 },
    }));

    expect(risk).toBe(1200);
  });
});
