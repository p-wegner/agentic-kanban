import { describe, it, expect } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { tagClass, formatTableDate, isOverdue, resolveRowCells } from "./tableView-cells.js";

function issue(over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "i1", issueNumber: 1, title: "T", statusName: "Todo",
    priority: "medium", issueType: "task", updatedAt: "2026-01-02T00:00:00Z",
    tags: [], ...over,
  } as IssueWithStatus;
}

describe("tagClass", () => {
  it("maps known colors and falls back to gray", () => {
    expect(tagClass("blue")).toBe("bg-blue-100 text-blue-700");
    expect(tagClass(null)).toBe("bg-gray-100 text-gray-600");
    expect(tagClass("chartreuse")).toBe("bg-gray-100 text-gray-600");
  });
});

describe("formatTableDate", () => {
  it("formats as Mon D, YYYY", () => {
    expect(formatTableDate("2026-03-04T00:00:00Z")).toMatch(/Mar \d{1,2}, 2026/);
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-06-20T12:00:00Z");
  it("is false without a due date", () => {
    expect(isOverdue(issue({ dueDate: undefined }), now)).toBe(false);
  });
  it("is true for a past due date on an open issue", () => {
    expect(isOverdue(issue({ dueDate: "2026-06-10T00:00:00Z", statusName: "In Progress" }), now)).toBe(true);
  });
  it("is false for a future due date", () => {
    expect(isOverdue(issue({ dueDate: "2026-06-30T00:00:00Z" }), now)).toBe(false);
  });
  it("is false when the issue is Done or Cancelled even if past due", () => {
    expect(isOverdue(issue({ dueDate: "2026-06-10T00:00:00Z", statusName: "Done" }), now)).toBe(false);
    expect(isOverdue(issue({ dueDate: "2026-06-10T00:00:00Z", statusName: "Cancelled" }), now)).toBe(false);
  });
});

describe("resolveRowCells", () => {
  const now = new Date("2026-06-20T12:00:00Z");
  it("resolves badge classes/labels with fallbacks", () => {
    const cells = resolveRowCells(issue({ statusName: "Weird", priority: undefined, issueType: undefined }), now);
    expect(cells.statusClass).toBe("text-gray-600 bg-gray-100");
    expect(cells.priority).toBe("medium");
    expect(cells.priorityLabel).toBe("Medium");
    expect(cells.type).toBe("task");
    expect(cells.typeLabel).toBe("Task");
  });

  it("builds a due cell only when a due date exists", () => {
    expect(resolveRowCells(issue({ dueDate: undefined }), now).due).toBeNull();
    const due = resolveRowCells(issue({ dueDate: "2026-06-10T00:00:00Z", statusName: "In Progress" }), now).due;
    expect(due?.overdue).toBe(true);
    expect(due?.text).toMatch(/Jun/);
  });

  it("maps tags with their color classes", () => {
    const cells = resolveRowCells(issue({ tags: [{ id: "t1", name: "ui", color: "blue" }] as IssueWithStatus["tags"] }), now);
    expect(cells.tags).toEqual([{ id: "t1", name: "ui", className: "bg-blue-100 text-blue-700" }]);
  });
});
