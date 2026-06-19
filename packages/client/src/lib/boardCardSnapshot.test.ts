import { describe, it, expect } from "vitest";
import { stringifyForIssueCard } from "./boardCardSnapshot.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";

// deferUntilIdle is window-dependent (requestIdleCallback/setTimeout); the client
// vitest env is node (no DOM), so it's covered by build + runtime, not unit-tested here.

function issue(over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return { id: "i1", issueNumber: 1, title: "T", statusId: "s", statusName: "Todo", projectId: "p", priority: "medium", ...over } as IssueWithStatus;
}

describe("stringifyForIssueCard", () => {
  it("is stable for equal card data and changes when a tracked field changes", () => {
    expect(stringifyForIssueCard(issue())).toBe(stringifyForIssueCard(issue()));
    expect(stringifyForIssueCard(issue({ title: "A" }))).not.toBe(stringifyForIssueCard(issue({ title: "B" })));
  });

  it("reflects readyForMerge (a non-typed field)", () => {
    const a = stringifyForIssueCard({ ...issue(), readyForMerge: true } as IssueWithStatus);
    const b = stringifyForIssueCard(issue());
    expect(a).not.toBe(b);
  });
});
