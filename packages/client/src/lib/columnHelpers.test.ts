import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { groupByPriority, groupByTag, computeColumnEstimate, sortIssues } from "./columnHelpers.js";

let counter = 0;

function issue(overrides: Partial<IssueWithStatus> = {}): IssueWithStatus {
  counter++;
  return {
    id: `issue-${counter}`,
    issueNumber: counter,
    title: `Issue ${counter}`,
    description: null,
    priority: "medium",
    issueType: "task",
    sortOrder: counter,
    statusId: "status-1",
    projectId: "project-1",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    statusChangedAt: null,
    statusName: "Todo",
    ...overrides,
  };
}

describe("groupByPriority", () => {
  it("groups issues by priority in lane order, dropping empty lanes", () => {
    const low = issue({ priority: "low" });
    const critical = issue({ priority: "critical" });
    const groups = groupByPriority([low, critical]);
    expect(groups.map((g) => g.key)).toEqual(["critical", "low"]);
    expect(groups[0].issues).toEqual([critical]);
    expect(groups[1].issues).toEqual([low]);
  });

  it("puts a missing priority into the ungrouped lane", () => {
    // priority is typed string but can be null at runtime (DB) — the helper guards it
    const none = issue({ priority: null as unknown as string });
    const groups = groupByPriority([none]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("ungrouped");
    expect(groups[0].issues).toEqual([none]);
  });

  it("folds the legacy `urgent` value into the critical lane, not ungrouped (#516)", () => {
    // This assertion is INVERTED from what it pinned before. `urgent` is a legacy input
    // alias the server now folds to `critical`; treating it as an unknown value dropped
    // a genuinely critical issue into an unstyled lane at the bottom of the board.
    const legacy = issue({ priority: "urgent" });
    const groups = groupByPriority([legacy]);
    expect(groups.map((g) => g.key)).toEqual(["critical"]);
  });

  it("folds an unrecognised value to the normaliser's default lane, NOT ungrouped", () => {
    // `ungrouped` means "no priority set" — a real, distinct state. An unrecognised
    // string is a priority the client cannot read, and normalizeIssuePriority's default
    // (`medium`) is the one place that decides what it means. Re-deciding that here is
    // exactly the two-rules drift #516 removes.
    const nonsense = issue({ priority: "banana" });
    expect(groupByPriority([nonsense]).map((g) => g.key)).toEqual(["medium"]);
  });

  it("returns no groups for an empty column", () => {
    expect(groupByPriority([])).toEqual([]);
  });
});

describe("groupByTag", () => {
  it("groups by tag sorted by label, with untagged issues last as Ungrouped", () => {
    const tagB = { id: "t-b", name: "beta", color: "#00f" };
    const tagA = { id: "t-a", name: "alpha", color: null };
    const tagged = issue({ tags: [tagB] });
    const taggedA = issue({ tags: [tagA] });
    const untagged = issue({ tags: [] });
    const groups = groupByTag([tagged, taggedA, untagged]);
    expect(groups.map((g) => g.label)).toEqual(["alpha", "beta", "Ungrouped"]);
    expect(groups[0].color).toBeNull();
    expect(groups[1].color).toBe("#00f");
    expect(groups[2].key).toBe("ungrouped");
    expect(groups[2].issues).toEqual([untagged]);
  });

  it("lists a multi-tagged issue in every matching lane", () => {
    const t1 = { id: "t-1", name: "one", color: null };
    const t2 = { id: "t-2", name: "two", color: null };
    const multi = issue({ tags: [t1, t2] });
    const groups = groupByTag([multi]);
    expect(groups).toHaveLength(2);
    expect(groups[0].issues).toEqual([multi]);
    expect(groups[1].issues).toEqual([multi]);
  });
});

describe("computeColumnEstimate", () => {
  it("sums known estimate points and counts the rest as unestimated", () => {
    const issues = [
      issue({ estimate: "XS" }), // 1
      issue({ estimate: "L" }), // 5
      issue({ estimate: "XXL" }), // unknown -> unestimated
      issue({ estimate: null }),
      issue({}),
    ];
    expect(computeColumnEstimate(issues)).toEqual({ total: 6, unestimated: 3 });
  });
});

describe("sortIssues", () => {
  it("returns the input array untouched in default mode", () => {
    const issues = [issue({ issueType: "chore" }), issue({ issueType: "bug" })];
    expect(sortIssues(issues, "default")).toBe(issues);
  });

  it("sorts by issue type order (bug, feature, task, chore) without mutating input", () => {
    const chore = issue({ issueType: "chore" });
    const bug = issue({ issueType: "bug" });
    const feature = issue({ issueType: "feature" });
    const untyped = issue({ issueType: null as unknown as string });
    const input = [chore, untyped, feature, bug];
    const sorted = sortIssues(input, "type");
    expect(sorted.map((i) => i.id)).toEqual([bug.id, feature.id, untyped.id, chore.id]);
    expect(input[0]).toBe(chore);
  });
});
