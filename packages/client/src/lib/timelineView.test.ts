import { describe, it, expect } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { PRIORITY_META } from "./chartColors.js";
import {
  computeLanes,
  pctOf,
  toggleTypeSet,
  computeIssueBar,
  ALL_TYPES,
  DAY_MS,
  PRIORITY_COLORS,
  PRIORITY_ORDER,
  type DateRange,
} from "./timelineView.js";

const priorityColor = (key: string) => PRIORITY_META.find((p) => p.key === key)!.color;

function issue(over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: over.id ?? "i1",
    issueNumber: 1,
    title: over.title ?? "Title",
    description: over.description ?? "",
    issueType: over.issueType ?? "task",
    priority: over.priority ?? "medium",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: over.updatedAt ?? "2026-01-02T00:00:00Z",
    statusChangedAt: over.statusChangedAt ?? null,
    dueDate: over.dueDate,
    ...over,
  } as IssueWithStatus;
}
function col(name: string, issues: IssueWithStatus[], count?: number): StatusWithIssues {
  return { id: name, name, issues, count: count ?? issues.length } as unknown as StatusWithIssues;
}

describe("computeLanes", () => {
  const columns = [
    col("In Progress", [issue({ id: "a", issueType: "bug", title: "fix login" })]),
    col("Done", [issue({ id: "b", issueType: "task", title: "ship it" })]),
    col("Todo", []),
  ];

  it("drops completed lanes when showCompleted is false", () => {
    const lanes = computeLanes(columns, { showCompleted: false, activeTypes: new Set(ALL_TYPES), query: "" });
    expect(lanes.map((l) => l.name)).toEqual(["In Progress"]);
  });

  it("keeps completed lanes when showCompleted is true and drops empty lanes", () => {
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "" });
    expect(lanes.map((l) => l.name)).toEqual(["In Progress", "Done"]);
  });

  it("filters by active type", () => {
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(["bug"]), query: "" });
    expect(lanes.map((l) => l.name)).toEqual(["In Progress"]);
  });

  it("filters by search query over title/description", () => {
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "login" });
    expect(lanes.flatMap((l) => l.issues.map((i) => i.id))).toEqual(["a"]);
  });

  it("#1086 P1-3: carries the column's true total and returned count, not just the filtered length", () => {
    // A terminal column truncated server-side to 50: `count` (the true total) exceeds
    // `issues.length` (what the server actually returned).
    const capped = [col("Done", [issue({ id: "b" })], 137)];
    const lanes = computeLanes(capped, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "" });
    expect(lanes[0].count).toBe(137);
    expect(lanes[0].returnedCount).toBe(1);
  });

  it("returnedCount reflects what the server sent BEFORE client-side filtering", () => {
    const columns2 = [col("Todo", [issue({ id: "a", issueType: "bug" }), issue({ id: "b", issueType: "task" })])];
    const lanes = computeLanes(columns2, { showCompleted: true, activeTypes: new Set(["bug"]), query: "" });
    expect(lanes[0].issues).toHaveLength(1); // filtered down to the bug
    expect(lanes[0].returnedCount).toBe(2); // but the server sent both
    expect(lanes[0].count).toBe(2); // and there were only 2 total (no server-side cap)
  });
});

describe("pctOf", () => {
  const range: DateRange = { min: 0, max: 100 };
  it("maps timestamps to 0-100", () => {
    expect(pctOf(0, range)).toBe(0);
    expect(pctOf(50, range)).toBe(50);
    expect(pctOf(100, range)).toBe(100);
  });
});

describe("toggleTypeSet", () => {
  it("adds an inactive type", () => {
    expect(toggleTypeSet(new Set(["bug"]), "task")).toEqual(new Set(["bug", "task"]));
  });
  it("removes an active type when others remain", () => {
    expect(toggleTypeSet(new Set(["bug", "task"]), "task")).toEqual(new Set(["bug"]));
  });
  it("resets to all types when removing the last active one", () => {
    expect(toggleTypeSet(new Set(["bug"]), "bug")).toEqual(new Set(ALL_TYPES));
  });
});

describe("computeIssueBar", () => {
  const range: DateRange = { min: 0, max: 100 };

  it("#1086 P1-2 remainder A: a valid due date is a MARKER, not the bar's end", () => {
    const bar = computeIssueBar(
      issue({ createdAt: new Date(20).toISOString(), dueDate: new Date(60).toISOString(), issueType: "feature", priority: "high" }),
      range,
      false,
      90, // open issue: bar ends at "now", the due date no longer moves the end
    );
    expect(bar.startPct).toBe(20);
    expect(bar.spanPct).toBe(70); // 90 - 20, unaffected by the due date
    expect(bar.duePct).toBe(60); // the due date shows up as its own marker instead
    expect(bar.type).toBe("feature");
    expect(bar.priorityColor).toBe(priorityColor("high"));
    expect(bar.invalidDueDate).toBe(false);
  });

  it("has no due marker for an issue with no due date", () => {
    const bar = computeIssueBar(issue({ createdAt: new Date(20).toISOString(), dueDate: null }), range, false, 90);
    expect(bar.duePct).toBeNull();
  });

  it("has no due marker when the due date falls outside the visible window", () => {
    const bar = computeIssueBar(
      issue({ createdAt: new Date(20).toISOString(), dueDate: new Date(500).toISOString() }),
      range,
      false,
      90,
    );
    expect(bar.duePct).toBeNull();
  });

  it("falls back to task colors and medium priority for unknown values", () => {
    const bar = computeIssueBar(issue({ issueType: "weird", priority: "weird" }), range, false, 50);
    expect(bar.colors).toBe(computeIssueBar(issue({ issueType: "task" }), range, false, 50).colors);
    expect(bar.priorityColor).toBe(priorityColor("medium"));
  });

  it("#1088 P1-2: an OPEN issue's bar ends at 'now', not at its last edit", () => {
    const bar = computeIssueBar(
      issue({ createdAt: new Date(10).toISOString(), updatedAt: new Date(20).toISOString(), dueDate: null }),
      range,
      false,
      90,
    );
    expect(bar.spanPct).toBe(80); // 90 - 10
    expect(bar.isOpen).toBe(true);
  });

  it("#1088 P1-2: a COMPLETED issue's bar ends at statusChangedAt, not at a later edit", () => {
    const bar = computeIssueBar(
      issue({
        createdAt: new Date(10).toISOString(),
        statusChangedAt: new Date(40).toISOString(),
        updatedAt: new Date(90).toISOString(), // a later comment/edit after it was closed
        dueDate: null,
      }),
      range,
      true,
      95,
    );
    expect(bar.spanPct).toBe(30); // 40 - 10, not 90 - 10 (updatedAt) or 95 - 10 (now)
    expect(bar.isOpen).toBe(false);
  });

  it("#1088 P1-2: a COMPLETED issue with no statusChangedAt falls back to updatedAt", () => {
    const bar = computeIssueBar(
      issue({ createdAt: new Date(10).toISOString(), statusChangedAt: null, updatedAt: new Date(40).toISOString(), dueDate: null }),
      range,
      true,
      95,
    );
    expect(bar.spanPct).toBe(30); // 40 - 10
  });

  it("#1088 P1-2: a due date before the created date is flagged invalid and falls back to the open/closed rule instead of a negative span", () => {
    const bar = computeIssueBar(
      issue({ createdAt: new Date(60).toISOString(), dueDate: new Date(20).toISOString() }),
      range,
      false,
      90,
    );
    expect(bar.invalidDueDate).toBe(true);
    expect(bar.spanPct).toBe(30); // falls back to nowMs (90) - created (60), never negative
    expect(bar.duePct).toBeNull(); // an invalid due date is never shown as a marker either
  });

  it("a valid due date on the created date itself is not flagged invalid", () => {
    const t = new Date(30).toISOString();
    const bar = computeIssueBar(issue({ createdAt: t, dueDate: t }), range, false, 30);
    expect(bar.invalidDueDate).toBe(false);
    expect(bar.spanPct).toBe(0);
    expect(bar.duePct).toBe(30);
  });

  describe("#1086 P1-1: clipping via clipSpan", () => {
    it("returns null startPct and skips drawing a bar entirely outside the visible window", () => {
      const bar = computeIssueBar(
        issue({ createdAt: new Date(200).toISOString(), statusChangedAt: new Date(300).toISOString() }),
        range,
        true,
      );
      expect(bar.startPct).toBeNull();
      expect(bar.spanPct).toBe(0);
    });

    it("clips a bar that starts before the window and marks it as continuing", () => {
      const bar = computeIssueBar(
        issue({ createdAt: new Date(-50).toISOString(), statusChangedAt: new Date(30).toISOString() }),
        range,
        true,
      );
      expect(bar.startPct).toBe(0);
      expect(bar.clippedStart).toBe(true);
      expect(bar.clippedEnd).toBe(false);
    });

    it("clips a bar that ends after the window and marks it as continuing", () => {
      const bar = computeIssueBar(
        issue({ createdAt: new Date(80).toISOString() }),
        range,
        false,
        500, // an open issue whose "now" end is far past the visible window
      );
      expect(bar.clippedEnd).toBe(true);
      expect(bar.startPct! + bar.spanPct).toBeCloseTo(100, 5);
    });
  });

  describe("#1086 P1-5: due date parsing avoids the timezone-west-of-UTC shift", () => {
    it("reads a bare 'YYYY-MM-DD' due date as LOCAL midnight, not UTC midnight", () => {
      // A due date one day after `createdAt`'s local midnight. `new Date("2026-03-02")` parses
      // as UTC midnight, which in any timezone west of UTC is still "2026-03-01" locally — the
      // exact off-by-one #1086/#1091 already fixed for IssueCard/IssueMetadataGrid.
      const created = new Date(2026, 2, 1, 0, 0, 0); // local midnight, March 1
      const localRange: DateRange = { min: created.getTime() - DAY_MS, max: created.getTime() + 5 * DAY_MS };
      const bar = computeIssueBar(
        issue({ createdAt: created.toISOString(), dueDate: "2026-03-02" }),
        localRange,
        false,
        created.getTime(),
      );
      const expectedDueLocalMidnight = new Date(2026, 2, 2, 0, 0, 0).getTime();
      expect(bar.duePct).toBeCloseTo(pctOf(expectedDueLocalMidnight, localRange), 5);
      expect(bar.invalidDueDate).toBe(false);
    });
  });
});

describe("computeLanes — search by issue number (#1086/#1091 P1-4)", () => {
  it("matches a bare issue number", () => {
    const columns = [col("Todo", [issue({ id: "a", issueNumber: 42, title: "Unrelated title" })])];
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "42" });
    expect(lanes.flatMap((l) => l.issues.map((i) => i.id))).toEqual(["a"]);
  });

  it("matches a #-prefixed issue number", () => {
    const columns = [col("Todo", [issue({ id: "a", issueNumber: 42, title: "Unrelated title" })])];
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "#42" });
    expect(lanes.flatMap((l) => l.issues.map((i) => i.id))).toEqual(["a"]);
  });

  it("does not match a different issue number", () => {
    const columns = [col("Todo", [issue({ id: "a", issueNumber: 42, title: "Unrelated title" })])];
    const lanes = computeLanes(columns, { showCompleted: true, activeTypes: new Set(ALL_TYPES), query: "43" });
    expect(lanes).toEqual([]);
  });
});

describe("#1086 P3-a: priority colors are derived from chartColors.PRIORITY_META, not a second table", () => {
  it("matches PRIORITY_META for every priority", () => {
    for (const p of PRIORITY_META) {
      expect(PRIORITY_COLORS[p.key]).toBe(p.color);
    }
  });

  it("orders the legend critical -> high -> medium -> low, matching PRIORITY_META", () => {
    expect(PRIORITY_ORDER).toEqual(PRIORITY_META.map((p) => p.key));
  });
});
