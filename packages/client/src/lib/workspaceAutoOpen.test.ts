import { describe, it, expect } from "vitest";
import { shouldAutoOpenWorkspacePanel } from "./workspaceAutoOpen.js";

const NOTHING_OPEN = { selectedIssueId: null, workspaceIssueId: null };

describe("shouldAutoOpenWorkspacePanel (#973)", () => {
  it("opens when the user has not touched anything during the launch", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: NOTHING_OPEN,
        after: NOTHING_OPEN,
        launchedIssueId: "issue-a",
      }),
    ).toBe(true);
  });

  it("opens when the same detail panel was open before and after", () => {
    const open = { selectedIssueId: "issue-a", workspaceIssueId: null };
    expect(
      shouldAutoOpenWorkspacePanel({ before: open, after: open, launchedIssueId: "issue-a" }),
    ).toBe(true);
  });

  it("refuses when the user opened a DIFFERENT issue while the launch was in flight", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: NOTHING_OPEN,
        after: { selectedIssueId: "issue-b", workspaceIssueId: null },
        launchedIssueId: "issue-a",
      }),
    ).toBe(false);
  });

  it("refuses when the user opened a different workspace drawer meanwhile", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: NOTHING_OPEN,
        after: { selectedIssueId: null, workspaceIssueId: "issue-b" },
        launchedIssueId: "issue-a",
      }),
    ).toBe(false);
  });

  it("refuses when the user CLOSED the panel they had open (Escape = 'no panel')", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: { selectedIssueId: "issue-b", workspaceIssueId: null },
        after: NOTHING_OPEN,
        launchedIssueId: "issue-a",
      }),
    ).toBe(false);
  });

  it("opens when the user navigated TO the launched issue meanwhile — that is their context", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: NOTHING_OPEN,
        after: { selectedIssueId: "issue-a", workspaceIssueId: null },
        launchedIssueId: "issue-a",
      }),
    ).toBe(true);
  });

  it("opens when the launched issue's own workspace drawer is already the open one", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: NOTHING_OPEN,
        after: { selectedIssueId: null, workspaceIssueId: "issue-a" },
        launchedIssueId: "issue-a",
      }),
    ).toBe(true);
  });

  it("refuses when the user moved from the launched issue to another one", () => {
    expect(
      shouldAutoOpenWorkspacePanel({
        before: { selectedIssueId: "issue-a", workspaceIssueId: null },
        after: { selectedIssueId: "issue-b", workspaceIssueId: null },
        launchedIssueId: "issue-a",
      }),
    ).toBe(false);
  });
});
