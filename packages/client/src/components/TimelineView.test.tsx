// @covers client.timelineView.render [ui, boundary, error-handling]
//
// #729: `TimelineView.tsx` is tied for the most-reworked untested client component (31
// fix-shaped commits in the 90-day window). Its pure geometry lives in
// `lib/timelineView.ts` and IS tested; what was untested is the component itself — which
// is where "the timeline is blank", "the lane count is wrong" and "an issue with no due
// date has no bar" are actually observed.
//
// These assert what the user sees for a given board state: the empty state vs. the chart,
// the lane/issue counts in the toolbar, which lanes appear at all, and that every visible
// issue gets exactly one row with a bar. Nothing here asserts a class name for its own
// sake or the internal component split — the toolbar and the lanes are addressed by their
// rendered TEXT so the file can be re-cut without breaking these.
//
// The package has no `@testing-library/react` (see the note atop useApiResource.test.ts),
// so interaction (zoom, pan, the type chips, the hover tooltip) is not reachable here and
// is deliberately not faked; only the FIRST render of a given state is pinned.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { TimelineView } from "./TimelineView.js";

const DAY = 86_400_000;

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY).toISOString();
}

function issue(over: Partial<IssueWithStatus> & { id: string; title: string }): IssueWithStatus {
  return {
    issueNumber: 1,
    description: null,
    issueType: "task",
    priority: "medium",
    createdAt: iso(7),
    updatedAt: iso(1),
    dueDate: null,
    tags: [],
    ...over,
  } as IssueWithStatus;
}

function column(name: string, issues: IssueWithStatus[]): StatusWithIssues {
  return { id: name.toLowerCase(), name, projectId: "p", sortOrder: 0, issues, count: issues.length } as StatusWithIssues;
}

function render(columns: StatusWithIssues[], searchQuery?: string): string {
  return renderToStaticMarkup(
    <TimelineView columns={columns} onIssueClick={() => {}} searchQuery={searchQuery} />,
  );
}

/** How many issue rows the chart drew, counted by the per-row `#<n>` label. */
function rowCount(html: string): number {
  return [...html.matchAll(/>#\d+</g)].length;
}

const EMPTY_MESSAGE = "No issues to display on the timeline";

describe("TimelineView — nothing to show", () => {
  it("shows the empty state for a board with no columns", () => {
    expect(render([])).toContain(EMPTY_MESSAGE);
  });

  it("shows the empty state when every column is empty, rather than an axis with no rows", () => {
    // An axis and lane headers over zero rows reads as a broken chart, not as "no work".
    const html = render([column("Todo", []), column("Done", [])]);
    expect(html).toContain(EMPTY_MESSAGE);
    expect(html).not.toContain("Today");
  });

  it("shows the empty state when the search matches nothing", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Add pagination" })])], "nothing matches this");
    expect(html).toContain(EMPTY_MESSAGE);
  });
});

describe("TimelineView — the chart", () => {
  const board = [
    column("Todo", [
      issue({ id: "a", issueNumber: 11, title: "Add pagination" }),
      issue({ id: "b", issueNumber: 12, title: "Cache the board" }),
    ]),
    column("In Progress", [issue({ id: "c", issueNumber: 13, title: "Fix the header" })]),
  ];

  it("draws one row per visible issue, labelled with its number and title", () => {
    const html = render(board);
    expect(html).not.toContain(EMPTY_MESSAGE);
    expect(rowCount(html)).toBe(3);
    expect(html).toContain("#11");
    expect(html).toContain("Add pagination");
    expect(html).toContain("Fix the header");
  });

  it("summarises the visible work as an issue and lane count", () => {
    // This line is how a user notices a filter is on; it must count what is DRAWN.
    expect(render(board)).toContain("3 issues across 2 statuses");
  });

  it("uses singular wording for one issue in one status", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Only one" })])]);
    expect(html).toContain("1 issue across 1 status");
    expect(html).not.toContain("1 issues");
  });

  it("marks where today is on the axis", () => {
    expect(render(board)).toContain("Today");
  });

  it("omits a lane whose issues were all filtered out, rather than drawing an empty lane", () => {
    const html = render(board, "pagination");
    expect(rowCount(html)).toBe(1);
    expect(html).toContain("1 issue across 1 status");
    expect(html).not.toContain("In Progress");
  });

  it("searches descriptions as well as titles", () => {
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Opaque title", description: "the CSV export path" })])],
      "csv",
    );
    expect(html).toContain("Opaque title");
  });
});

describe("TimelineView — issues the range has to cope with", () => {
  it("renders an issue with no due date (the common case) rather than skipping it", () => {
    // The bar's end falls back to `updatedAt`; a null due date used to produce no bar.
    const html = render([column("Todo", [issue({ id: "a", issueNumber: 7, title: "No deadline", dueDate: null })])]);
    expect(html).toContain("#7");
    expect(html).toContain("No deadline");
    expect(rowCount(html)).toBe(1);
  });

  it("renders a single issue created and updated in the same instant", () => {
    // A zero-width time span must not collapse the chart or divide by zero.
    const t = iso(0);
    const html = render([column("Todo", [issue({ id: "a", title: "Just filed", createdAt: t, updatedAt: t })])]);
    expect(html).toContain("Just filed");
    expect(html).not.toContain("NaN");
  });

  it("renders an issue due far in the future without producing NaN geometry", () => {
    const far = new Date(Date.now() + 400 * DAY).toISOString();
    const html = render([column("Todo", [issue({ id: "a", title: "Long horizon", dueDate: far })])]);
    expect(html).toContain("Long horizon");
    expect(html).not.toContain("NaN");
  });

  it("renders an overdue issue", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Overdue thing", dueDate: iso(3) })])]);
    expect(html).toContain("Overdue thing");
    expect(html).not.toContain("NaN");
  });

  it("shows completed lanes by default", () => {
    // The default is "show everything"; hiding Done silently is a reported confusion.
    const html = render([column("Done", [issue({ id: "a", title: "Shipped it" })])]);
    expect(html).toContain("Shipped it");
    expect(html).toContain("Done");
  });
});
