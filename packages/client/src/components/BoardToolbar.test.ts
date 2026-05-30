import { describe, expect, it } from "vitest";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { formatBoardActivitySummary } from "./BoardToolbar.js";

function column(name: string, count: number): StatusWithIssues {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    projectId: "project-1",
    name,
    sortOrder: 0,
    issues: Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}` }) as any),
  } as StatusWithIssues;
}

describe("formatBoardActivitySummary", () => {
  it("formats non-empty active counts with active work first", () => {
    expect(formatBoardActivitySummary([
      column("Todo", 2),
      column("In Progress", 3),
      column("In Review", 2),
    ])).toBe("3 In Progress, 2 In Review, 2 Todo");
  });

  it("omits empty statuses", () => {
    expect(formatBoardActivitySummary([
      column("Todo", 0),
      column("In Progress", 1),
      column("In Review", 0),
    ])).toBe("1 In Progress");
  });
});
