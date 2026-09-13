import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { matchesBoardFilters, type BoardFilterOptions } from "./boardFiltering.js";

function makeIssue(overrides: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "issue-1",
    issueNumber: 1,
    title: "Some issue",
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    statusId: "status-1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusChangedAt: null,
    statusName: "Todo",
    ...overrides,
  };
}

const baseOptions: BoardFilterOptions = {
  focusMode: false,
  statusFilterId: null,
  activeTagIds: new Set<string>(),
  milestoneFilterId: null,
  driveFilterId: null,
  issueTypeFilter: null,
  priorityFilter: null,
  showBlocked: false,
  showStaleOnly: false,
  searchQuery: "",
};

describe("matchesBoardFilters — drive filter", () => {
  it("matches an issue whose drive id equals the filter", () => {
    const issue = makeIssue({ drive: { id: "drive-1", target: "Ship it" } });
    expect(matchesBoardFilters(issue, { ...baseOptions, driveFilterId: "drive-1" })).toBe(true);
  });

  it("excludes an issue belonging to a different drive", () => {
    const issue = makeIssue({ drive: { id: "drive-2", target: "Other" } });
    expect(matchesBoardFilters(issue, { ...baseOptions, driveFilterId: "drive-1" })).toBe(false);
  });

  it("excludes an issue with no drive when a drive filter is active", () => {
    const issue = makeIssue({ drive: null });
    expect(matchesBoardFilters(issue, { ...baseOptions, driveFilterId: "drive-1" })).toBe(false);
  });

  it("is a no-op when no drive filter is set", () => {
    const issue = makeIssue({ drive: null });
    expect(matchesBoardFilters(issue, baseOptions)).toBe(true);
  });
});
