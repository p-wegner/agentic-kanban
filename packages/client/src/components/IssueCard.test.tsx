import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { IssueCard } from "./IssueCard.js";

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
  };
}

function render(i: IssueWithStatus): string {
  return renderToStaticMarkup(
    <IssueCard
      issue={i}
      onClick={() => {}}
      onDragStart={() => {}}
    />,
  );
}

describe("IssueCard external tracker link", () => {
  it("renders a link with the external key when externalUrl is present", () => {
    const html = render(
      issue({ externalKey: "PROJ-123", externalUrl: "https://tracker.example.com/browse/PROJ-123" }),
    );
    expect(html).toContain('href="https://tracker.example.com/browse/PROJ-123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("PROJ-123");
  });

  it("falls back to a generic label when only the URL is set", () => {
    const html = render(issue({ externalUrl: "https://tracker.example.com/x" }));
    expect(html).toContain('href="https://tracker.example.com/x"');
    expect(html).toContain("link");
  });

  it("renders no tracker link when externalUrl is absent", () => {
    const html = render(issue());
    expect(html).not.toContain("Open in external tracker");
  });
});
