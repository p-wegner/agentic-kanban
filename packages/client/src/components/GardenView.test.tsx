import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { GardenView } from "./GardenView.js";

function makeIssue(overrides: Partial<IssueWithStatus>): IssueWithStatus {
  return {
    id: "issue-1",
    issueNumber: 1,
    title: "Water the tomatoes",
    priority: "medium",
    ...overrides,
  } as IssueWithStatus;
}

const columns: StatusWithIssues[] = [
  {
    id: "status-todo",
    name: "Todo",
    issues: [makeIssue({ id: "issue-1", issueNumber: 1, title: "Plan the bed" })],
  },
  {
    id: "status-done",
    name: "Done",
    issues: [makeIssue({ id: "issue-2", issueNumber: 2, title: "Harvest", priority: "high" })],
  },
] as unknown as StatusWithIssues[];

describe("GardenView", () => {
  it("renders every issue as a plant grouped by its status bed", () => {
    const html = renderToStaticMarkup(
      <GardenView columns={columns} onIssueClick={() => {}} />,
    );

    expect(html).toContain("Garden");
    expect(html).toContain("Todo");
    expect(html).toContain("Done");
    expect(html).toContain("#1");
    expect(html).toContain("#2");
    expect(html).toContain("2 issues growing across 2 beds");
  });

  it("filters plants by the search query", () => {
    const html = renderToStaticMarkup(
      <GardenView columns={columns} onIssueClick={() => {}} searchQuery="harvest" />,
    );

    expect(html).toContain("#2");
    expect(html).not.toContain("#1");
    expect(html).toContain("Empty bed");
  });

  it("renders an empty bed when a status has no matching issues", () => {
    const emptyColumns: StatusWithIssues[] = [
      { id: "status-todo", name: "Todo", issues: [] },
    ] as unknown as StatusWithIssues[];

    const html = renderToStaticMarkup(
      <GardenView columns={emptyColumns} onIssueClick={() => {}} />,
    );

    expect(html).toContain("Empty bed");
    expect(html).toContain("0 issues growing across 1 bed");
  });
});
