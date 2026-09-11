import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { IssueMetadataGrid } from "./IssueMetadataGrid.js";

function issue(overrides: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "issue-1",
    issueNumber: 7,
    title: "An issue",
    description: null,
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    statusId: "status-1",
    projectId: "project-1",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    statusChangedAt: null,
    statusName: "Todo",
    ...overrides,
  } as IssueWithStatus;
}

function render(i: IssueWithStatus): string {
  return renderToStaticMarkup(
    <IssueMetadataGrid
      editing={false}
      issue={i}
      statuses={[{ id: "status-1", name: "Todo" }]}
      issueType="task"
      setIssueType={() => {}}
      estimate=""
      setEstimate={() => {}}
      dueDate=""
      setDueDate={() => {}}
      externalKey=""
      setExternalKey={() => {}}
      externalUrl=""
      setExternalUrl={() => {}}
      skipAutoReview={false}
      setSkipAutoReview={() => {}}
      milestoneId={null}
      setMilestoneId={() => {}}
      milestones={[]}
      estimating={false}
      handleStatusChange={() => {}}
      handleQuickEstimate={() => {}}
      handleAiEstimate={() => {}}
      badgeColor="bg-slate-100 text-slate-700"
      issueTypeDisplay="Task"
    />,
  );
}

describe("IssueMetadataGrid due date — local-midnight parsing (#1091 P1-5)", () => {
  it("renders a YYYY-MM-DD due date on the same calendar day it names, regardless of timezone offset", () => {
    // Parsing a date-only string via `new Date("2026-01-15")` reads it as UTC midnight, which
    // prints as the day BEFORE in any timezone west of UTC. `parseLocalDate` reads it as local
    // midnight instead, so the due date shown always matches what was actually set.
    const html = render(issue({ dueDate: "2026-01-15", statusName: "Todo" }));
    expect(html).toContain("Jan 15, 2026");
  });
});
