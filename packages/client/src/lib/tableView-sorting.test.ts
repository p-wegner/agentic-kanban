// @covers client.tableView.sort [ui-state, boundary, regression]
//
// #729: the other untested half of `TableView.tsx`'s view logic (31 fix-shaped commits,
// no test at any level). What a user sees when they click a column header is entirely
// this comparator, and every column has its own "missing value" rule that has been got
// wrong at least once:
//
//   * an unnumbered (still-optimistic) issue must not outrank a real one arbitrarily;
//   * priority ranks by SEVERITY, not alphabetically — and #516's regression was that
//     `PRIORITY_ORDER` listed a value (`urgent`) no colour map knew, so it sorted top and
//     rendered unstyled. That the table is DERIVED from the one priority table is the fix,
//     so it is asserted here rather than re-listing the ranks;
//   * an unestimated issue sorts LAST, not as if it were XS;
//   * an issue with no due date sorts last in BOTH directions is *not* true — descending
//     genuinely puts it first, and that is pinned so nobody "fixes" it by accident.

import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  applySortDirection,
  compareSortKey,
  ESTIMATE_ORDER,
  ISSUE_TYPE_ORDER,
  PRIORITY_ORDER,
  type SortKey,
} from "./tableView-sorting.js";
import { ISSUE_PRIORITIES, PRIORITY_TRAITS } from "./priorityTraits.js";

function issue(over: Partial<IssueWithStatus> & { id: string }): IssueWithStatus {
  return {
    title: "Untitled",
    statusName: "Todo",
    issueNumber: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as IssueWithStatus;
}

/** Sorts by one column the way TableView does, and returns the visible id order. */
function sorted(list: IssueWithStatus[], key: SortKey, dir: "asc" | "desc" = "asc"): string[] {
  return [...list]
    .sort((a, b) => applySortDirection(compareSortKey(a, b, key), dir))
    .map((i) => i.id);
}

describe("compareSortKey — number", () => {
  it("orders by issue number ascending", () => {
    const rows = [issue({ id: "c", issueNumber: 30 }), issue({ id: "a", issueNumber: 7 })];
    expect(sorted(rows, "number")).toEqual(["a", "c"]);
  });

  it("sorts a not-yet-numbered issue below every numbered one", () => {
    // A card that is still being created has `issueNumber: null`; treating it as 0 keeps
    // it at the top of the ascending list instead of jumping around.
    const rows = [issue({ id: "n7", issueNumber: 7 }), issue({ id: "pending", issueNumber: null })];
    expect(sorted(rows, "number")).toEqual(["pending", "n7"]);
  });
});

describe("compareSortKey — priority", () => {
  it("ranks by severity, not alphabetically", () => {
    const rows = ISSUE_PRIORITIES.map((p) => issue({ id: p, priority: p }));
    const order = sorted(rows, "priority");
    // critical first, however the four are spelled.
    expect(order[0]).toBe("critical");
    expect(order).toEqual([...ISSUE_PRIORITIES].sort((a, b) => PRIORITY_TRAITS[a].order - PRIORITY_TRAITS[b].order));
  });

  it("is derived from the one priority table, so a value the colour maps know cannot be missing (#516)", () => {
    // The #516 regression was a hand-written rank list that had a row the styling maps
    // did not: sorted to the top, rendered unstyled. Deriving is what prevents that.
    expect(Object.keys(PRIORITY_ORDER).sort()).toEqual([...ISSUE_PRIORITIES].sort());
  });

  it("treats a missing priority as medium rather than as unranked", () => {
    const rows = [
      issue({ id: "none", priority: undefined }),
      issue({ id: "low", priority: "low" }),
      issue({ id: "high", priority: "high" }),
    ];
    expect(sorted(rows, "priority")).toEqual(["high", "none", "low"]);
  });
});

describe("compareSortKey — type", () => {
  it("puts bugs first and chores last", () => {
    const rows = Object.keys(ISSUE_TYPE_ORDER).map((t) => issue({ id: t, issueType: t as IssueWithStatus["issueType"] }));
    expect(sorted(rows, "type")).toEqual(["bug", "feature", "task", "chore"]);
  });

  it("treats an unknown or missing type as a task", () => {
    const rows = [
      issue({ id: "unknown", issueType: "spike" as IssueWithStatus["issueType"] }),
      issue({ id: "bug", issueType: "bug" }),
      issue({ id: "chore", issueType: "chore" }),
    ];
    expect(sorted(rows, "type")).toEqual(["bug", "unknown", "chore"]);
  });
});

describe("compareSortKey — estimate", () => {
  it("orders by size, not by the label's alphabet", () => {
    const rows = Object.keys(ESTIMATE_ORDER).map((e) => issue({ id: e, estimate: e as IssueWithStatus["estimate"] }));
    expect(sorted(rows, "estimate")).toEqual(["XS", "S", "M", "L", "XL"]);
  });

  it("sorts an unestimated issue LAST, not as the smallest", () => {
    // "Not sized yet" is the opposite of "tiny"; conflating them hides the unsized work
    // at the top of the list, which is where a planner stops reading.
    const rows = [issue({ id: "none", estimate: null }), issue({ id: "XL", estimate: "XL" })];
    expect(sorted(rows, "estimate")).toEqual(["XL", "none"]);
  });
});

describe("compareSortKey — dueDate", () => {
  it("puts the soonest deadline first", () => {
    const rows = [
      issue({ id: "later", dueDate: "2026-09-01" }),
      issue({ id: "soon", dueDate: "2026-08-25" }),
    ];
    expect(sorted(rows, "dueDate")).toEqual(["soon", "later"]);
  });

  it("sorts an issue with no due date after every dated one ascending, and before them descending", () => {
    const rows = [issue({ id: "none", dueDate: null }), issue({ id: "dated", dueDate: "2026-09-01" })];
    // Ascending = "what is due next", so undated work is not a deadline and goes last.
    expect(sorted(rows, "dueDate", "asc")).toEqual(["dated", "none"]);
    // Descending is the plain reverse — undated leads. Pinned deliberately: it is a
    // consequence of using Infinity, and it is the current, shipped behaviour.
    expect(sorted(rows, "dueDate", "desc")).toEqual(["none", "dated"]);
  });
});

describe("compareSortKey — text and time columns", () => {
  it("orders titles the way the user's locale reads them", () => {
    const rows = [issue({ id: "b", title: "banana" }), issue({ id: "A", title: "Apple" })];
    expect(sorted(rows, "title")).toEqual(["A", "b"]);
  });

  it("orders by status name", () => {
    const rows = [issue({ id: "t", statusName: "Todo" }), issue({ id: "d", statusName: "Done" })];
    expect(sorted(rows, "status")).toEqual(["d", "t"]);
  });

  it("orders by update time, oldest first ascending", () => {
    const rows = [
      issue({ id: "new", updatedAt: "2026-08-22T10:00:00.000Z" }),
      issue({ id: "old", updatedAt: "2026-01-02T10:00:00.000Z" }),
    ];
    expect(sorted(rows, "updated")).toEqual(["old", "new"]);
    expect(sorted(rows, "updated", "desc")).toEqual(["new", "old"]);
  });
});

describe("applySortDirection", () => {
  it("leaves ascending alone and negates descending", () => {
    expect(applySortDirection(-1, "asc")).toBeLessThan(0);
    expect(applySortDirection(-1, "desc")).toBeGreaterThan(0);
  });

  it("keeps ties as ties in both directions", () => {
    // A direction flip must not invent an order between equal rows. `-0` counts as a tie
    // for Array.prototype.sort, so compare the magnitude rather than the sign bit.
    expect(Math.abs(applySortDirection(0, "asc"))).toBe(0);
    expect(Math.abs(applySortDirection(0, "desc"))).toBe(0);
  });
});
