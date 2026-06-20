import { describe, it, expect } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import {
  fmtAxisDate,
  computeLanes,
  computeBaseRange,
  computeTicks,
  pctOf,
  toggleTypeSet,
  computeIssueBar,
  ALL_TYPES,
  DAY_MS,
  type DateRange,
} from "./timelineView.js";

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
    dueDate: over.dueDate,
    ...over,
  } as IssueWithStatus;
}
function col(name: string, issues: IssueWithStatus[]): StatusWithIssues {
  return { id: name, name, issues } as unknown as StatusWithIssues;
}

describe("fmtAxisDate", () => {
  it("shows time for sub-2-day spans, date otherwise", () => {
    const d = new Date("2026-03-04T13:05:00Z");
    expect(fmtAxisDate(d, DAY_MS)).toMatch(/\d{1,2}:\d{2}/);
    expect(fmtAxisDate(d, 10 * DAY_MS)).toMatch(/Mar/);
  });
});

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
});

describe("computeBaseRange", () => {
  it("returns a 7-day window ending now for an empty set", () => {
    const r = computeBaseRange([]);
    expect(r.max - r.min).toBeCloseTo(7 * DAY_MS, -5);
  });

  it("spans created→due with padding", () => {
    const r = computeBaseRange([issue({ createdAt: "2026-01-01T00:00:00Z", dueDate: "2026-01-11T00:00:00Z" })]);
    // 10 day span, +Date.now() pulls max out; just assert min is padded below the created date
    expect(r.min).toBeLessThan(new Date("2026-01-01T00:00:00Z").getTime());
  });
});

describe("computeTicks", () => {
  it("produces between a few and ~11 ticks with no duplicate labels", () => {
    const range: DateRange = { min: new Date("2026-01-01").getTime(), max: new Date("2026-02-01").getTime() };
    const ticks = computeTicks(range);
    const labels = ticks.map((t) => fmtAxisDate(t, range.max - range.min));
    expect(new Set(labels).size).toBe(labels.length); // deduped
    expect(ticks.length).toBeGreaterThanOrEqual(3);
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
  it("computes start/span pct and resolves colors", () => {
    const bar = computeIssueBar(issue({ createdAt: new Date(20).toISOString(), dueDate: new Date(60).toISOString(), issueType: "feature", priority: "high" }), range);
    expect(bar.startPct).toBe(20);
    expect(bar.spanPct).toBe(40);
    expect(bar.type).toBe("feature");
    expect(bar.priorityColor).toBe("#f97316");
  });
  it("clamps a negative span to 0", () => {
    const bar = computeIssueBar(issue({ createdAt: new Date(60).toISOString(), dueDate: new Date(20).toISOString() }), range);
    expect(bar.spanPct).toBe(0);
  });
  it("falls back to task colors and medium priority for unknown values", () => {
    const bar = computeIssueBar(issue({ issueType: "weird", priority: "weird" }), range);
    expect(bar.colors).toBe(computeIssueBar(issue({ issueType: "task" }), range).colors);
    expect(bar.priorityColor).toBe("#eab308");
  });
});
