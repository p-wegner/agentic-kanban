import { describe, it, expect } from "vitest";
import type { DependencyItem } from "@agentic-kanban/shared";
import { computeBlockingDependencies, canDecomposeIssue } from "./blockingDependencies.js";

const dep = (over: Partial<DependencyItem>): DependencyItem => ({
  id: "d",
  issueId: "self",
  dependsOnId: "other",
  type: "depends_on",
  createdAt: "",
  issueTitle: "Dep",
  issueStatusName: "Todo",
  issueNumber: 1,
  ...over,
} as DependencyItem);

describe("computeBlockingDependencies", () => {
  const SELF = "self";

  it("keeps outgoing blocking-type deps with an unresolved target", () => {
    const out = computeBlockingDependencies([dep({ id: "a", issueStatusName: "In Progress" })], SELF);
    expect(out.map((d) => d.id)).toEqual(["a"]);
  });

  it("excludes incoming edges (this issue blocks them)", () => {
    const out = computeBlockingDependencies([dep({ id: "a", issueId: "other" })], SELF);
    expect(out).toEqual([]);
  });

  it("excludes non-blocking dependency types", () => {
    const out = computeBlockingDependencies([dep({ id: "a", type: "related" as DependencyItem["type"] })], SELF);
    expect(out).toEqual([]);
  });

  it("excludes resolved targets (case-insensitive: done/cancelled/ai reviewed)", () => {
    const deps = [
      dep({ id: "done", issueStatusName: "Done" }),
      dep({ id: "cancelled", issueStatusName: "CANCELLED" }),
      dep({ id: "reviewed", issueStatusName: "AI Reviewed" }),
      dep({ id: "open", issueStatusName: "In Review" }),
    ];
    expect(computeBlockingDependencies(deps, SELF).map((d) => d.id)).toEqual(["open"]);
  });

  it("accepts the blocked_by type too", () => {
    const out = computeBlockingDependencies([dep({ id: "a", type: "blocked_by", issueStatusName: "Todo" })], SELF);
    expect(out.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("canDecomposeIssue", () => {
  it("is true for a long description", () => {
    expect(canDecomposeIssue("x".repeat(501), [])).toBe(true);
    expect(canDecomposeIssue("x".repeat(500), [])).toBe(false);
  });
  it("is true when tagged 'epic'", () => {
    expect(canDecomposeIssue("short", [{ name: "epic" }])).toBe(true);
    expect(canDecomposeIssue("short", [{ name: "bug" }])).toBe(false);
  });
  it("handles a missing description", () => {
    expect(canDecomposeIssue(null, [])).toBe(false);
    expect(canDecomposeIssue(undefined, [{ name: "epic" }])).toBe(true);
  });
});
