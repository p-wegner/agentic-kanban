import { describe, it, expect } from "vitest";
import { findCycleNodes, type DirectedEdge } from "../src/lib/dependency-graph.js";

// #523: this replaces two verbatim-duplicated recursive DFS copies (auto-chain + wave).
// The shared version is ITERATIVE, so the first job of these tests is to pin that it
// agrees with the recursive original on the shapes that distinguish the two — a node
// that REACHES a cycle is not on it, and a deep chain must not blow the stack.

const e = (from: string, to: string, type = "depends_on"): DirectedEdge & { type: string } =>
  ({ from, to, type });

describe("findCycleNodes (#523)", () => {
  it("returns nothing for an acyclic graph", () => {
    expect([...findCycleNodes(["a", "b", "c"], [e("a", "b"), e("b", "c")])]).toEqual([]);
  });

  it("returns exactly the nodes ON the cycle, not the ones that merely reach it", () => {
    // d -> a -> b -> c -> a. `d` reaches the cycle but is not part of it.
    const cycle = findCycleNodes(["a", "b", "c", "d"], [e("d", "a"), e("a", "b"), e("b", "c"), e("c", "a")]);
    expect([...cycle].sort()).toEqual(["a", "b", "c"]);
    expect(cycle.has("d")).toBe(false);
  });

  it("finds a self-loop", () => {
    expect([...findCycleNodes(["a"], [e("a", "a")])]).toEqual(["a"]);
  });

  it("finds two disjoint cycles in one pass", () => {
    const cycle = findCycleNodes(
      ["a", "b", "x", "y", "z"],
      [e("a", "b"), e("b", "a"), e("x", "y"), e("y", "z"), e("z", "x")],
    );
    expect([...cycle].sort()).toEqual(["a", "b", "x", "y", "z"]);
  });

  it("ignores edges that leave the scoped node set", () => {
    // b is not in scope, so a -> b -> a cannot be seen as a cycle.
    expect([...findCycleNodes(["a"], [e("a", "b"), e("b", "a")])]).toEqual([]);
  });

  it("applies the edge filter — the ONLY thing the two copies differed in", () => {
    const edges = [e("a", "b", "blocked_by"), e("b", "a", "related_to")];
    const blocking = (edge: { type: string }) => edge.type === "blocked_by";
    // With both types admitted it is a cycle; filtered to blocking edges only, it is not.
    expect([...findCycleNodes(["a", "b"], edges)].sort()).toEqual(["a", "b"]);
    expect([...findCycleNodes(["a", "b"], edges, blocking)]).toEqual([]);
  });

  it("handles a chain far deeper than the recursion limit", () => {
    // The recursive copies would overflow here; this is the reason for the rewrite.
    const n = 50_000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges = ids.slice(0, -1).map((id, i) => e(id, ids[i + 1]));
    expect(() => findCycleNodes(ids, edges)).not.toThrow();
    expect(findCycleNodes(ids, edges).size).toBe(0);

    // Same chain, closed into one big cycle: every node is on it.
    expect(findCycleNodes(ids, [...edges, e(ids[n - 1], ids[0])]).size).toBe(n);
  });
});
