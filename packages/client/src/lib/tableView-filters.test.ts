// @covers client.tableView.filter [ui-state, boundary, error-handling]
//
// #729: `TableView.tsx` is one of the two most-reworked client components (31 fix-shaped
// commits in the 90-day window) and had no test at any level. Its filtering was already
// extracted into this pure module, but the module itself was untested — so the behaviour
// a user actually depends on (the status dropdown, the created-date chip and the search
// box all narrowing the SAME list, together) was unpinned.
//
// These pin what the table SHOWS for a given filter state, not how it computes it: the
// three filters compose (AND), "active" means "not archived" rather than a named status,
// search covers the description as well as the title, and an issue with no description is
// not a crash. Each of those is a distinct way the table has been reported wrong.

import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { ARCHIVE_STATUSES, filterIssues } from "./tableView-filters.js";
import { getLocalDateKey } from "./dateKey.js";

/** A local-midnight ISO timestamp, so the created-date key is unambiguous under any TZ. */
function localNoon(daysAgo: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function issue(over: Partial<IssueWithStatus> & { id: string }): IssueWithStatus {
  return {
    title: "Untitled",
    description: null,
    statusName: "Todo",
    createdAt: localNoon(0),
    ...over,
  } as IssueWithStatus;
}

const todo = issue({ id: "a", title: "Add pagination", statusName: "Todo" });
const done = issue({ id: "b", title: "Fix the header", statusName: "Done" });
const cancelled = issue({ id: "c", title: "Drop the widget", statusName: "Cancelled" });
const review = issue({ id: "d", title: "Review the gate", statusName: "In Review" });
const all = [todo, done, cancelled, review];

function ids(list: IssueWithStatus[]): string[] {
  return list.map((i) => i.id);
}

describe("filterIssues — the status dropdown", () => {
  it('"active" hides everything the board treats as archived', () => {
    // The default view: a user should not have to scroll past months of Done work.
    expect(ids(filterIssues(all, { statusFilter: "active" }))).toEqual(["a", "d"]);
  });

  it('both archive statuses are hidden by "active", not just Done', () => {
    // Cancelled work is archived too — it used to leak into the active table.
    expect([...ARCHIVE_STATUSES]).toEqual(expect.arrayContaining(["Done", "Cancelled"]));
    expect(ids(filterIssues([done, cancelled], { statusFilter: "active" }))).toEqual([]);
  });

  it('"all" shows archived issues as well', () => {
    expect(ids(filterIssues(all, { statusFilter: "all" }))).toEqual(["a", "b", "c", "d"]);
  });

  it("a named status shows only that status — including an archived one", () => {
    // Picking "Done" explicitly must override the active/archive rule, otherwise the
    // dropdown offers a choice that silently returns nothing.
    expect(ids(filterIssues(all, { statusFilter: "Done" }))).toEqual(["b"]);
  });

  it("a status nothing is in yields an empty table rather than everything", () => {
    expect(filterIssues(all, { statusFilter: "Blocked" })).toEqual([]);
  });
});

describe("filterIssues — the search box", () => {
  it("matches the title case-insensitively", () => {
    expect(ids(filterIssues(all, { statusFilter: "all", searchQuery: "PAGINATION" }))).toEqual(["a"]);
  });

  it("matches on the description too, not only the title", () => {
    const withDesc = issue({ id: "e", title: "Nothing obvious", description: "the CSV export path" });
    expect(ids(filterIssues([todo, withDesc], { statusFilter: "all", searchQuery: "csv" }))).toEqual(["e"]);
  });

  it("treats an issue with no description as simply not matching", () => {
    // Every issue here has `description: null`; a null-unsafe search crashes the table.
    expect(filterIssues(all, { statusFilter: "all", searchQuery: "csv" })).toEqual([]);
  });

  it("an empty query is not a filter", () => {
    expect(ids(filterIssues(all, { statusFilter: "all", searchQuery: "" }))).toHaveLength(4);
    expect(ids(filterIssues(all, { statusFilter: "all", searchQuery: undefined }))).toHaveLength(4);
  });
});

describe("filterIssues — the created-date chip", () => {
  it("keeps only issues created on the chosen local day", () => {
    const older = issue({ id: "old", createdAt: localNoon(3) });
    const today = getLocalDateKey(new Date());
    expect(ids(filterIssues([todo, older], { statusFilter: "all", createdDateFilter: today }))).toEqual(["a"]);
  });

  it("is not applied when absent", () => {
    expect(ids(filterIssues(all, { statusFilter: "all", createdDateFilter: null }))).toHaveLength(4);
  });
});

describe("filterIssues — the filters compose", () => {
  it("narrows by status AND date AND text at once", () => {
    // Drilling in from the activity chart: "Todo work created today mentioning export".
    const target = issue({ id: "hit", title: "Export queue", statusName: "Todo", createdAt: localNoon(0) });
    const wrongStatus = issue({ id: "m1", title: "Export queue", statusName: "Done", createdAt: localNoon(0) });
    const wrongDay = issue({ id: "m2", title: "Export queue", statusName: "Todo", createdAt: localNoon(5) });
    const wrongText = issue({ id: "m3", title: "Import queue", statusName: "Todo", createdAt: localNoon(0) });

    const result = filterIssues([target, wrongStatus, wrongDay, wrongText], {
      statusFilter: "active",
      searchQuery: "export",
      createdDateFilter: getLocalDateKey(new Date()),
    });

    expect(ids(result)).toEqual(["hit"]);
  });

  it("preserves the incoming order — sorting is a separate concern", () => {
    // The table sorts after filtering; a filter that reordered would fight the sort.
    expect(ids(filterIssues([review, todo], { statusFilter: "active" }))).toEqual(["d", "a"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [...all];
    filterIssues(input, { statusFilter: "active" });
    expect(ids(input)).toEqual(["a", "b", "c", "d"]);
  });
});
