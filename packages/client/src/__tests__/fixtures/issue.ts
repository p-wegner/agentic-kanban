import type { IssueWithStatus } from "@agentic-kanban/shared";

/**
 * Fixture builders for the client's test suite (#782).
 *
 * The client tests without jsdom — pure functions plus `renderToStaticMarkup` — which works
 * right up to a component or module whose input is a WIDE object. Then every test file grows
 * its own 20-line literal, they drift, and the components with the biggest props (the ones
 * with the most rework) end up with no test because the setup cost is the whole test. These
 * builders are that setup cost, paid once.
 *
 * Convention: a builder takes `Partial<T>` and spreads it LAST, so a test states only the
 * fields it is about and the reader sees the point of the case immediately.
 */

/** A saved issue as the board's API returns it. Realistic defaults; override what matters. */
export function issueFixture(overrides: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "issue-1",
    issueNumber: 782,
    title: "Existing title",
    description: "Existing description",
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    statusId: "status-todo",
    projectId: "project-1",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    statusChangedAt: new Date(Date.now() - 86_400_000).toISOString(),
    statusName: "Todo",
    estimate: null,
    dueDate: null,
    externalKey: null,
    externalUrl: null,
    skipAutoReview: false,
    milestoneId: null,
    ...overrides,
  };
}
