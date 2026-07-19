import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { BoardStats } from "./BoardStats.js";

function col(name: string, count: number): StatusWithIssues {
  return { id: name, name, projectId: "p", sortOrder: 0, issues: [], count } as StatusWithIssues;
}

describe("BoardStats backlog count badge (#118)", () => {
  it("renders the Backlog column's count at a glance", () => {
    const html = renderToStaticMarkup(
      <BoardStats
        activeColumns={[col("In Progress", 2)]}
        archiveColumns={[col("Done", 1)]}
        backlogColumn={col("Backlog", 7)}
      />,
    );
    expect(html).toContain('data-testid="backlog-count-badge"');
    expect(html).toContain(">7<");
    expect(html).toContain(">Backlog<");
  });

  it("updates live when the backlog column's count changes", () => {
    const before = renderToStaticMarkup(
      <BoardStats
        activeColumns={[]}
        archiveColumns={[]}
        backlogColumn={col("Backlog", 3)}
      />,
    );
    expect(before).toContain(">3<");

    const after = renderToStaticMarkup(
      <BoardStats
        activeColumns={[]}
        archiveColumns={[]}
        backlogColumn={col("Backlog", 4)}
      />,
    );
    expect(after).toContain(">4<");
    expect(after).not.toContain(">3<");
  });

  it("omits the badge when there is no Backlog column", () => {
    const html = renderToStaticMarkup(
      <BoardStats activeColumns={[]} archiveColumns={[]} />,
    );
    expect(html).not.toContain('data-testid="backlog-count-badge"');
  });
});
