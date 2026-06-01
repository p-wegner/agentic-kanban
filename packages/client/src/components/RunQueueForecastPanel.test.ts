import { describe, expect, it } from "vitest";
import { buildRunQueueForecast } from "./RunQueueForecastPanel.js";
import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";

function workspace(overrides: Partial<MainWorkspaceInfo>): MainWorkspaceInfo {
  return {
    id: overrides.id ?? `ws-${overrides.branch ?? "branch"}`,
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

function issue(overrides: Partial<IssueWithStatus> & { title: string }): IssueWithStatus {
  const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    id: `issue-${overrides.title}`,
    issueNumber: Number(overrides.title.match(/\d+/)?.[0] ?? 1),
    title: overrides.title,
    description: null,
    priority: "medium",
    issueType: "feature",
    sortOrder: 0,
    statusId: "status-todo",
    projectId: "project-1",
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    statusName: "Todo",
    ...overrides,
  };
}

function withWorkspace(base: IssueWithStatus, workspaceInfo: MainWorkspaceInfo): IssueWithStatus {
  return {
    ...base,
    workspaceSummary: {
      total: 1,
      active: workspaceInfo.status === "active" ? 1 : 0,
      idle: workspaceInfo.status === "idle" ? 1 : 0,
      closed: workspaceInfo.status === "closed" ? 1 : 0,
      branches: [workspaceInfo.branch],
      main: workspaceInfo,
    },
  };
}

function columns(issues: IssueWithStatus[]): StatusWithIssues[] {
  return [
    { id: "backlog", name: "Backlog", projectId: "project-1", sortOrder: 0, issues: issues.filter((i) => i.statusName === "Backlog") },
    { id: "todo", name: "Todo", projectId: "project-1", sortOrder: 1, issues: issues.filter((i) => i.statusName === "Todo") },
    { id: "progress", name: "In Progress", projectId: "project-1", sortOrder: 2, issues: issues.filter((i) => i.statusName === "In Progress") },
    { id: "review", name: "In Review", projectId: "project-1", sortOrder: 3, issues: issues.filter((i) => i.statusName === "In Review") },
  ];
}

describe("run queue forecast", () => {
  it("counts active capacity from current workspace statuses", () => {
    const running = withWorkspace(issue({ title: "running 1", statusName: "In Progress" }), workspace({ status: "active" }));
    const fixing = withWorkspace(issue({ title: "fixing 2", statusName: "In Progress" }), workspace({ status: "fixing" }));
    const reviewing = withWorkspace(issue({ title: "reviewing 3", statusName: "In Review" }), workspace({ status: "reviewing" }));
    const idle = withWorkspace(issue({ title: "idle 4", statusName: "In Review" }), workspace({ status: "idle", readyForMerge: true }));

    const forecast = buildRunQueueForecast(columns([running, fixing, reviewing, idle]), "5");

    expect(forecast.activeTarget).toBe(5);
    expect(forecast.runningCount).toBe(2);
    expect(forecast.reviewCount).toBe(1);
    expect(forecast.idleCount).toBe(1);
    expect(forecast.pendingMergeCount).toBe(2);
    expect(forecast.openSlots).toBe(2);
  });

  it("returns the next two startable issues ordered by status, priority, and sort order", () => {
    const running = withWorkspace(
      issue({ title: "running 1", statusName: "In Progress" }),
      workspace({ status: "active", lastSessionAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
    );
    const blockedHigh = issue({ title: "blocked 2", priority: "critical", isBlocked: true, sortOrder: 0 });
    const backlogCritical = issue({ title: "backlog 3", statusName: "Backlog", priority: "critical", sortOrder: 0 });
    const todoMedium = issue({ title: "todo medium 4", priority: "medium", sortOrder: 0 });
    const todoHigh = issue({ title: "todo high 5", priority: "high", sortOrder: 1 });

    const forecast = buildRunQueueForecast(columns([running, blockedHigh, backlogCritical, todoMedium, todoHigh]), 1);

    expect(forecast.openSlots).toBe(0);
    expect(forecast.nextStarts.map((start) => start.issue.title)).toEqual(["todo high 5", "todo medium 4"]);
    expect(forecast.nextStarts[0].slotLabel).toBe("#1 agent finishes");
    expect(forecast.nextStarts[1].slotLabel).toBe("after current queue clears");
  });
});
