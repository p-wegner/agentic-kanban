import { describe, expect, it } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { reconcileSelectedIssue } from "./selectedIssueSync.js";

function issue(over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "i1",
    title: "Title",
    description: "Body",
    issueType: "task",
    statusId: "s1",
    statusName: "Todo",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as IssueWithStatus;
}

function columns(...issues: IssueWithStatus[]): StatusWithIssues[] {
  return [{ id: "s1", name: "Todo", issues } as unknown as StatusWithIssues];
}

describe("reconcileSelectedIssue", () => {
  it("reports no change when the board issue is identical", () => {
    const sel = issue();
    expect(reconcileSelectedIssue(columns(issue()), sel)).toEqual({ changed: false });
  });

  it("clears the selection when the issue is gone from the board", () => {
    expect(reconcileSelectedIssue(columns(), issue())).toEqual({ changed: true, next: null });
  });

  it("updates in place when a tracked field changes", () => {
    const sel = issue({ title: "Old" });
    const result = reconcileSelectedIssue(columns(issue({ title: "New" })), sel);
    expect(result).toMatchObject({ changed: true });
    if (result.changed) expect(result.next?.title).toBe("New");
  });

  it("does NOT treat a stripped (undefined) board description as a change", () => {
    const sel = issue({ description: "Loaded body" });
    const stripped = issue({ description: undefined });
    expect(reconcileSelectedIssue(columns(stripped), sel)).toEqual({ changed: false });
  });

  it("preserves the locally-loaded description when another field changes and board strips it", () => {
    const sel = issue({ description: "Loaded body", title: "Old" });
    const stripped = issue({ description: undefined, title: "New" });
    const result = reconcileSelectedIssue(columns(stripped), sel);
    expect(result).toMatchObject({ changed: true });
    if (result.changed) {
      expect(result.next?.title).toBe("New");
      expect(result.next?.description).toBe("Loaded body");
    }
  });

  it("detects a real description edit coming from the board", () => {
    const sel = issue({ description: "Old body" });
    const result = reconcileSelectedIssue(columns(issue({ description: "New body" })), sel);
    expect(result).toMatchObject({ changed: true });
    if (result.changed) expect(result.next?.description).toBe("New body");
  });

  it("detects live workspace activity changes (status/contextTokens/lastTool)", () => {
    const sel = issue({ workspaceSummary: { main: { status: "active", contextTokens: 100, lastTool: "Read" } } } as Partial<IssueWithStatus>);
    const updated = issue({ workspaceSummary: { main: { status: "active", contextTokens: 200, lastTool: "Read" } } } as Partial<IssueWithStatus>);
    const result = reconcileSelectedIssue(columns(updated), sel);
    expect(result).toMatchObject({ changed: true });
  });
});
