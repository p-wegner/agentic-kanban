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
import { TimelineView, axisAnchor, axisLabelShift } from "./TimelineView.js";
import { TIMELINE_VIEW_ID } from "../lib/viewTabs.js";
import { useTimelineViewStore } from "../stores/timelineViewStore.js";

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

function column(name: string, issues: IssueWithStatus[], count?: number): StatusWithIssues {
  return { id: name.toLowerCase(), name, projectId: "p", sortOrder: 0, issues, count: count ?? issues.length } as StatusWithIssues;
}

function render(columns: StatusWithIssues[], searchQuery?: string, projectId?: string | null): string {
  return renderToStaticMarkup(
    <TimelineView columns={columns} onIssueClick={() => {}} searchQuery={searchQuery} projectId={projectId} />,
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
    // The toolbar (incl. its own "Today" nav button, #1086/#1091 P1-4) still renders — only
    // the chart body is replaced by the empty state — so this checks for the absence of any
    // drawn row, not for the literal word "Today" (which the toolbar always contains now).
    const html = render([column("Todo", []), column("Done", [])]);
    expect(html).toContain(EMPTY_MESSAGE);
    expect(rowCount(html)).toBe(0);
  });

  it("shows the empty state when the search matches nothing", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Add pagination" })])], "nothing matches this");
    expect(html).not.toContain(EMPTY_MESSAGE); // there IS an issue — a filter hid it, so #1086/#1091 P1-4 applies
    expect(html).toContain("No issues match the current filters");
  });

  it("#1086/#1091 P1-4: keeps the toolbar (incl. the Show completed toggle) visible when a filter hides everything", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Add pagination" })])], "nothing matches this");
    expect(html).toContain("Show completed");
  });

  it("#1086/#1091 P1-4: offers a one-click filter reset when a filter hides everything", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Add pagination" })])], "nothing matches this");
    expect(html).toContain("Reset type &amp; completed filters");
  });

  it("#1086/#1091 P1-4: does not offer a filter reset when there are genuinely no issues", () => {
    const html = render([column("Todo", [])]);
    expect(html).not.toContain("Reset type &amp; completed filters");
  });

  it("#1086/#1091 P1-4: search matches an issue by its number", () => {
    const html = render([column("Todo", [issue({ id: "a", issueNumber: 42, title: "Unrelated title" })])], "42");
    expect(html).toContain("Unrelated title");
  });

  it("#1086/#1091 P1-4: search matches an issue by a #-prefixed number", () => {
    const html = render([column("Todo", [issue({ id: "a", issueNumber: 42, title: "Unrelated title" })])], "#42");
    expect(html).toContain("Unrelated title");
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

  it("#1088 P2-7: shows a priority legend in the toolbar", () => {
    const html = render(board);
    expect(html).toContain("Priority");
    expect(html).toContain("critical");
    expect(html).toContain("Invalid due date");
  });

  it("#1099 P2-7: the legend also explains the Today line and a bar's start/end", () => {
    const html = render(board);
    expect(html).toContain("Bar: created");
    expect(html).toContain("Today");
  });

  it("#1099 P2-10: a bar's priority dot carries a shape class, not just a color", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "High prio", priority: "high" })])]);
    expect(html).toContain("rotate-45"); // "high" is a diamond
  });

  it("#1099 R1: the label column is sticky on horizontal scroll, in the header and every row", () => {
    const html = render(board);
    // The axis spacer (1) + one lane header per non-empty column (2) + one row label per
    // visible issue (3) — all carry `sticky left-0`.
    const totalIssues = board.reduce((n, c) => n + c.issues.length, 0);
    expect((html.match(/sticky left-0/g) ?? []).length).toBe(1 + board.length + totalIssues);
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
    // The bar's end falls back to "now" for an open issue (#1088 P1-2); a null due date used
    // to produce no bar at all.
    const html = render([column("Todo", [issue({ id: "a", issueNumber: 7, title: "No deadline", dueDate: null })])]);
    expect(html).toContain("#7");
    expect(html).toContain("No deadline");
    expect(rowCount(html)).toBe(1);
  });

  it("#1088 P1-2: flags a due date that predates the created date instead of a normal-looking bar", () => {
    // The toolbar's priority legend (#1088 P2-7) always shows a "⚠" as part of its own key,
    // so the dashed border — the bar-specific marker — is the signal checked here.
    const html = render([
      column("Todo", [issue({ id: "a", title: "Backwards due date", createdAt: iso(1), dueDate: iso(5) })]),
    ]);
    expect(html).toContain("border-dashed");
  });

  it("does not flag a well-formed due date as invalid", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Fine", createdAt: iso(5), dueDate: iso(1) })])]);
    expect(html).not.toContain("border-dashed");
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

/**
 * #1086 P1-1 correction to #1093: `clipSpan` was unit-tested but never wired into
 * `TimelineView.tsx` — bars were still positioned with a raw, unclamped `pctOf`, and the row
 * track had no `overflow-hidden`. These pin the fix at the component level: the track clips,
 * and a bar entirely outside the visible window draws nothing instead of piling at an edge.
 */
describe("TimelineView — bar clipping (#1086 P1-1)", () => {
  it("gives every row track overflow-hidden, so a floor-widened bar cannot spill past it", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Any issue" })])]);
    expect(html).toContain("flex-1 relative h-full overflow-hidden");
  });

  it("uses a small (~6px) readability floor instead of the old 90px one", () => {
    // A same-day issue (createdAt === updatedAt) has a 0%-span bar; only the floor keeps it visible.
    const t = iso(0);
    const html = render([column("Todo", [issue({ id: "a", title: "Same day", createdAt: t, updatedAt: t })])]);
    expect(html).toContain("max(6px");
    expect(html).not.toContain("max(90px");
  });

  it("draws no bar at all for an issue whose whole span falls outside the persisted viewport", () => {
    // Seed a narrow, far-future viewport (see the project-scoping tests above for the pattern)
    // so a present-day issue's [created, now] span is entirely to the LEFT of the visible window.
    const farFuture = Date.now() + 400 * DAY;
    useTimelineViewStore.setState({
      byView: { [`proj-clip:${TIMELINE_VIEW_ID}`]: { anchor: farFuture, pxPerMs: 1e-8, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"] } },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", issueNumber: 9, title: "Out of view", createdAt: iso(7), updatedAt: iso(1) })])],
      undefined,
      "proj-clip",
    );
    // The row (label) still renders — only the bar itself is skipped, so the issue is not
    // silently dropped from the chart, just drawn with no visible span.
    expect(html).toContain("#9");
    expect(html).toContain("Out of view");
    expect(rowCount(html)).toBe(1);
  });
});

describe("TimelineView — bar duration (#1086 P1-2 remainder A)", () => {
  it("shows an ongoing indicator on an open issue's bar", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Still working" })])]);
    expect(html).toContain("Still open — ongoing");
  });

  it("does not show the ongoing indicator on a completed issue's bar", () => {
    const html = render([column("Done", [issue({ id: "a", title: "Wrapped up" })])]);
    expect(html).not.toContain("Still open — ongoing");
  });

  it("draws a separate due-date marker instead of ending the bar at the due date", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Has a deadline", dueDate: iso(-2) })])]);
    expect(html).toMatch(/title="Due [A-Z][a-z]{2} \d{1,2}, \d{4}"/);
  });
});

describe("TimelineView — history cap notice (#1086 P1-3)", () => {
  it("shows the column's true total in the lane header, not just the loaded/filtered count", () => {
    const html = render([column("Done", [issue({ id: "a", title: "One of many" })], 137)]);
    expect(html).toContain(">137<");
  });

  it("shows a 'showing latest N of total' notice when the server truncated the column", () => {
    const html = render([column("Done", [issue({ id: "a", title: "One of many" })], 137)]);
    expect(html).toContain("showing latest 1 of 137");
  });

  it("shows no notice when the column was not truncated", () => {
    const html = render([column("Done", [issue({ id: "a", title: "Only issue" })])]);
    expect(html).not.toContain("showing latest");
  });
});

/**
 * #897 — the axis label anchoring that stops the view painting a horizontal scrollbar.
 *
 * Measured at 1440x900 before the fix: 48px of overflow on a view that otherwise fits. The
 * ticket blamed 90px issue-bar "markers"; the actual driver was the AXIS — `pctOf` already
 * clamps to 0-100, so a bar's percentages cannot overflow, but a label centred on the range's
 * final tick (always exactly 100%) hangs half its own width outside the track.
 *
 * Geometry is CSS, so this pins the two decisions rather than pixels: where the container is
 * anchored, and whether the label is centred. The `width: 0` in the middle branch is the part
 * that regressed once already during this fix — a container left at its natural width juts
 * past its own `left` origin and overflows even though the transformed label does not, which
 * was invisible at 1440px and a 6px scrollbar at 900px.
 */
/**
 * #1090 batch-2 follow-up: the persisted anchor/zoom/filter state is scoped per PROJECT,
 * not just per view id — otherwise switching projects while on the Timeline view would
 * restore a stale anchor/filter sitting outside the new project's issue-date range.
 *
 * The write happens in a `useEffect`, unreachable via `renderToStaticMarkup` (SSR runs no
 * effects) — see the file header. The read half (`persistedAtMount`, a `useRef` initializer)
 * runs synchronously during render, so it IS reachable: seed the store directly, then assert
 * on what the first render honours.
 */
describe("timeline persisted state is scoped by project (#1090)", () => {
  const board = [column("Done", [issue({ id: "a", title: "Shipped it" })])];

  it("honours a persisted showCompleted=false only for the project it was stored under", () => {
    useTimelineViewStore.setState({
      byView: { [`proj-1:${TIMELINE_VIEW_ID}`]: { anchor: 0, pxPerMs: 1, showCompleted: false, activeTypes: ["task"] } },
    });
    expect(render(board, undefined, "proj-1")).not.toContain("Shipped it");
  });

  it("does not leak proj-1's persisted state onto a different project", () => {
    useTimelineViewStore.setState({
      byView: { [`proj-1:${TIMELINE_VIEW_ID}`]: { anchor: 0, pxPerMs: 1, showCompleted: false, activeTypes: ["task"] } },
    });
    // proj-2 has nothing stored under its own key, so it falls back to the default (show all).
    expect(render(board, undefined, "proj-2")).toContain("Shipped it");
  });
});

describe("TimelineView — a11y (#1086 P2-10)", () => {
  const board = [column("Todo", [issue({ id: "a", issueNumber: 5, title: "Keyboard reachable" })])];

  it("renders the issue bar as a focusable button with an accessible name", () => {
    const html = render(board);
    expect(html).toMatch(/<button[^>]*aria-label="Keyboard reachable — Todo"/);
  });

  it("renders the row label as a clickable button too (#1086 P2-14)", () => {
    const html = render(board);
    expect(html).toMatch(/<button[^>]*>[\s\S]{0,200}#5</);
  });

  it("marks the priority dot with an accessible name instead of relying on color alone", () => {
    const html = render(board);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Priority: medium"/);
  });

  it("marks the active scale button with aria-pressed", () => {
    const html = render(board);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Month</);
  });

  it("marks an active type filter chip with aria-pressed", () => {
    const html = render(board);
    expect(html).toMatch(/aria-pressed="true"[^>]*>\s*<span[^>]*w-2\.5/);
  });
});

describe("TimelineView — priority/tag filters (P2-15 remainder, #1100)", () => {
  it("renders the priority/tag filter menu button in the toolbar", () => {
    const html = render([column("Todo", [issue({ id: "a", title: "Add pagination" })])]);
    expect(html).toContain("Priority/Tags");
  });

  it("honours a persisted priority filter, hiding issues of a different priority", () => {
    useTimelineViewStore.setState({
      byView: {
        [`proj-pri:${TIMELINE_VIEW_ID}`]: {
          anchor: 0, pxPerMs: 1, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"],
          activePriorities: ["critical"],
        },
      },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Low priority thing", priority: "low" })])],
      undefined,
      "proj-pri",
    );
    expect(html).not.toContain("Low priority thing");
    expect(html).toContain("No issues match the current filters");
  });

  it("shows a matching issue when its priority is in the persisted filter", () => {
    useTimelineViewStore.setState({
      byView: {
        [`proj-pri2:${TIMELINE_VIEW_ID}`]: {
          anchor: 0, pxPerMs: 1, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"],
          activePriorities: ["critical"],
        },
      },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Urgent thing", priority: "critical" })])],
      undefined,
      "proj-pri2",
    );
    expect(html).toContain("Urgent thing");
  });

  it("honours a persisted tag filter, hiding an issue with none of the selected tags", () => {
    useTimelineViewStore.setState({
      byView: {
        [`proj-tag:${TIMELINE_VIEW_ID}`]: {
          anchor: 0, pxPerMs: 1, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"],
          activeTagIds: ["t1"],
        },
      },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Untagged thing", tags: [] })])],
      undefined,
      "proj-tag",
    );
    expect(html).not.toContain("Untagged thing");
  });

  it("shows an issue carrying one of the selected tags", () => {
    useTimelineViewStore.setState({
      byView: {
        [`proj-tag2:${TIMELINE_VIEW_ID}`]: {
          anchor: 0, pxPerMs: 1, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"],
          activeTagIds: ["t1"],
        },
      },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Backend thing", tags: [{ id: "t1", name: "backend", color: null }] })])],
      undefined,
      "proj-tag2",
    );
    expect(html).toContain("Backend thing");
  });

  it("counts priority + tag filters toward the filter-reset condition", () => {
    useTimelineViewStore.setState({
      byView: {
        [`proj-tag3:${TIMELINE_VIEW_ID}`]: {
          anchor: 0, pxPerMs: 1, showCompleted: true, activeTypes: ["task", "bug", "feature", "chore"],
          activeTagIds: ["nonexistent-tag"],
        },
      },
    });
    const html = render(
      [column("Todo", [issue({ id: "a", title: "Anything" })])],
      undefined,
      "proj-tag3",
    );
    expect(html).toContain("Reset type &amp; completed filters");
  });
});

describe("timeline axis anchoring (#897)", () => {
  it("pins the final tick by its RIGHT edge, so its label cannot leave the track", () => {
    expect(axisAnchor(100)).toEqual({ right: 0 });
    expect(axisLabelShift(100)).toBe("");
  });

  it("treats a tick NEAR the end as a final tick — the range end is rarely exactly 100", () => {
    expect(axisAnchor(98.4)).toEqual({ right: 0 });
  });

  it("leaves the first tick's label flush left instead of centring it off the track", () => {
    expect(axisAnchor(0)).toEqual({ left: "0%", width: 0 });
    expect(axisLabelShift(0)).toBe("");
  });

  it("centres every interior label on its own tick", () => {
    expect(axisAnchor(50)).toEqual({ left: "50%", width: 0 });
    expect(axisLabelShift(50)).toBe("-translate-x-1/2");
  });

  it("gives every non-final container zero width, since the transform moves only the label", () => {
    for (const p of [0, 5, 25, 50, 75, 96]) {
      const anchor = axisAnchor(p);
      expect(anchor, `p=${p}`).toHaveProperty("width", 0);
    }
  });
});
