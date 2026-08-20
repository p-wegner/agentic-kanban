import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { BoardStats } from "./BoardStats.js";

function col(name: string, count: number): StatusWithIssues {
  return { id: name, name, projectId: "p", sortOrder: 0, issues: [], count } as StatusWithIssues;
}

describe("BoardStats", () => {
  // The Backlog count used to render here as a standalone pill (#118). It has
  // since moved onto the Backlog view tab in BoardToolbar so it shares the Board
  // tab's inline activity-summary treatment — one consistent tab-header pattern.
  it("no longer renders a standalone backlog-count badge", () => {
    const html = renderToStaticMarkup(
      <BoardStats activeColumns={[col("In Progress", 2)]} archiveColumns={[col("Done", 1)]} />,
    );
    expect(html).not.toContain('data-testid="backlog-count-badge"');
  });

  it("renders the open-work pulse count", () => {
    const html = renderToStaticMarkup(
      <BoardStats activeColumns={[col("In Progress", 2), col("In Review", 1)]} archiveColumns={[col("Done", 1)]} />,
    );
    expect(html).toContain('data-testid="board-stats-bar"');
    // 2 In Progress + 1 In Review = 3 open (active, non-archive) items.
    expect(html).toContain(">3<");
  });
});
