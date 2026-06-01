import { describe, it, expect } from "vitest";
import { computeCriticalPath, type IssueLike, type Dependency } from "./criticalPath.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<IssueLike> & { id: string }): IssueLike {
  return {
    title: `Issue ${overrides.id}`,
    statusName: "Todo",
    issueNumber: null,
    isBlocked: false,
    ...overrides,
  };
}

function makeDep(overrides: Partial<Dependency> & { id: string; issueId: string; dependsOnId: string; type: string }): Dependency {
  return overrides;
}

function dep(from: string, to: string, type = "depends_on"): Dependency {
  return makeDep({ id: `${from}-${to}`, issueId: to, dependsOnId: from, type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCriticalPath", () => {
  it("returns empty result for empty graph", () => {
    const result = computeCriticalPath([], []);
    expect(result.rootBlockers).toEqual([]);
    expect(result.cycleNodeIds.size).toBe(0);
    expect(result.chainsByRoot.size).toBe(0);
    expect(result.bestUnblock).toBeNull();
    expect(result.chainNodeIds.size).toBe(0);
  });

  it("returns empty result when there are no edges", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "Todo" }),
      makeIssue({ id: "b", statusName: "In Progress" }),
    ];
    const result = computeCriticalPath(nodes, []);
    expect(result.rootBlockers).toEqual([]);
    expect(result.bestUnblock).toBeNull();
  });

  it("returns empty result for a single unblocked issue", () => {
    const nodes = [makeIssue({ id: "a" })];
    const edges: Dependency[] = [];
    const result = computeCriticalPath(nodes, edges);
    expect(result.rootBlockers).toEqual([]);
  });

  it("identifies a linear chain: A→B→C (A is root blocker)", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo", isBlocked: true }),
      makeIssue({ id: "c", statusName: "Todo", isBlocked: true }),
    ];
    // A blocks B, B blocks C
    const edges = [dep("a", "b"), dep("b", "c")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.rootBlockers.length).toBe(1);
    expect(result.rootBlockers[0].id).toBe("a");
    expect(result.rootBlockers[0].downstreamCount).toBe(2);
    expect(result.rootBlockers[0].chainLength).toBe(3);
    expect(result.bestUnblock?.id).toBe("a");

    // Chain from root A should be A → B → C
    const chain = result.chainsByRoot.get("a")!;
    expect(chain.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("handles diamond shape: A→{B,C}→D", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo", isBlocked: true }),
      makeIssue({ id: "c", statusName: "Todo", isBlocked: true }),
      makeIssue({ id: "d", statusName: "Todo", isBlocked: true }),
    ];
    // A blocks B and C; B and C block D
    const edges = [dep("a", "b"), dep("a", "c"), dep("b", "d"), dep("c", "d")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.rootBlockers.length).toBe(1);
    expect(result.rootBlockers[0].id).toBe("a");
    expect(result.rootBlockers[0].downstreamCount).toBe(3);

    // Chain should be A → B → D or A → C → D (length 3)
    const chain = result.chainsByRoot.get("a")!;
    expect(chain.length).toBe(3);
    expect(chain[0].id).toBe("a");
    expect(chain[2].id).toBe("d");
  });

  it("detects cycles and excludes them", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo" }),
      makeIssue({ id: "c", statusName: "Todo" }),
    ];
    // A→B→A (cycle) — neither is a root blocker
    // A→C — C is blocked by A but A is in a cycle
    const edges = [dep("a", "b"), dep("b", "a"), dep("a", "c")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.cycleNodeIds.has("a")).toBe(true);
    expect(result.cycleNodeIds.has("b")).toBe(true);
    // C is not in the cycle
    expect(result.cycleNodeIds.has("c")).toBe(false);
    // No root blockers (A and B are cyclic)
    expect(result.rootBlockers.length).toBe(0);
    expect(result.bestUnblock).toBeNull();
  });

  it("ignores resolved blockers", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "Done" }),       // Resolved — edge should be inactive
      makeIssue({ id: "b", statusName: "Todo" }),
    ];
    // B depends on A, but A is Done → not a blocking edge
    const edges = [dep("a", "b")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.rootBlockers.length).toBe(0);
    expect(result.bestUnblock).toBeNull();
  });

  it("ignores resolved AI Reviewed blockers", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "AI Reviewed" }),
      makeIssue({ id: "b", statusName: "Todo" }),
    ];
    const edges = [dep("a", "b")];

    const result = computeCriticalPath(nodes, edges);
    expect(result.rootBlockers.length).toBe(0);
  });

  it("treats blocked_by identically to depends_on", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo", isBlocked: true }),
    ];
    // B is blocked_by A — same as A blocks B
    const edges = [dep("a", "b", "blocked_by")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.rootBlockers.length).toBe(1);
    expect(result.rootBlockers[0].id).toBe("a");
    expect(result.rootBlockers[0].downstreamCount).toBe(1);
  });

  it("selects best unblock by highest downstream count", () => {
    const nodes = [
      makeIssue({ id: "root1", statusName: "In Progress" }),
      makeIssue({ id: "root2", statusName: "In Progress" }),
      makeIssue({ id: "b1", statusName: "Todo" }),
      makeIssue({ id: "b2", statusName: "Todo" }),
      makeIssue({ id: "b3", statusName: "Todo" }),
      makeIssue({ id: "c1", statusName: "Todo" }),
    ];
    // root1 blocks b1 and b2; root2 blocks b3 and c1
    // b1 blocks b3 → root1 has 3 downstream (b1, b2, b3)
    // root2 has 2 downstream (b3, c1)
    const edges = [
      dep("root1", "b1"), dep("root1", "b2"),
      dep("b1", "b3"),
      dep("root2", "b3"), dep("root2", "c1"),
    ];

    const result = computeCriticalPath(nodes, edges);

    expect(result.bestUnblock).not.toBeNull();
    expect(result.bestUnblock!.downstreamCount).toBeGreaterThanOrEqual(3);
  });

  it("ignores non-blocking edge types (related_to, duplicates, parent_of, child_of)", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo" }),
    ];
    const edges = [
      dep("a", "b", "related_to"),
      dep("a", "b", "duplicates"),
      dep("a", "b", "parent_of"),
    ];

    const result = computeCriticalPath(nodes, edges);
    expect(result.rootBlockers.length).toBe(0);
    expect(result.bestUnblock).toBeNull();
  });

  it("populates chainNodeIds with all nodes in any chain", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "In Progress" }),
      makeIssue({ id: "b", statusName: "Todo" }),
      makeIssue({ id: "c", statusName: "Todo" }),
      makeIssue({ id: "d", statusName: "Todo" }),
    ];
    // A→B→C chain, D is independent
    const edges = [dep("a", "b"), dep("b", "c")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.chainNodeIds.has("a")).toBe(true);
    expect(result.chainNodeIds.has("b")).toBe(true);
    expect(result.chainNodeIds.has("c")).toBe(true);
    expect(result.chainNodeIds.has("d")).toBe(false);
  });

  it("handles multiple independent root blockers", () => {
    const nodes = [
      makeIssue({ id: "r1", statusName: "In Progress" }),
      makeIssue({ id: "r2", statusName: "In Progress" }),
      makeIssue({ id: "b1", statusName: "Todo" }),
      makeIssue({ id: "b2", statusName: "Todo" }),
    ];
    const edges = [dep("r1", "b1"), dep("r2", "b2")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.rootBlockers.length).toBe(2);
    const ids = result.rootBlockers.map((r) => r.id).sort();
    expect(ids).toEqual(["r1", "r2"]);
    expect(result.chainsByRoot.size).toBe(2);
  });

  it("chain step includes issue metadata", () => {
    const nodes = [
      makeIssue({ id: "a", title: "Root Issue", statusName: "In Progress", issueNumber: 42 }),
      makeIssue({ id: "b", title: "Blocked Work", statusName: "Todo", issueNumber: 43, isBlocked: true }),
    ];
    const edges = [dep("a", "b")];

    const result = computeCriticalPath(nodes, edges);
    const chain = result.chainsByRoot.get("a")!;

    expect(chain[0]).toEqual({
      id: "a",
      issueNumber: 42,
      title: "Root Issue",
      statusName: "In Progress",
      isBlocked: false,
    });
    expect(chain[1]).toEqual({
      id: "b",
      issueNumber: 43,
      title: "Blocked Work",
      statusName: "Todo",
      isBlocked: true,
    });
  });

  it("handles self-loop as cycle", () => {
    const nodes = [
      makeIssue({ id: "a", statusName: "Todo" }),
    ];
    const edges = [dep("a", "a")];

    const result = computeCriticalPath(nodes, edges);

    expect(result.cycleNodeIds.has("a")).toBe(true);
    expect(result.rootBlockers.length).toBe(0);
  });
});
