import { describe, it, expect } from "vitest";
import {
  addAdjacencyEdge,
  buildAdjacency,
  hasPath,
  wouldCreateCycle,
  type Adjacency,
} from "./dependency-graph.js";

describe("buildAdjacency / addAdjacencyEdge", () => {
  it("builds an adjacency map from edges, deduping parallel edges", () => {
    const adj = buildAdjacency([
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    expect([...adj.get("a")!]).toEqual(["b", "c"]);
    expect([...adj.get("b")!]).toEqual(["c"]);
    expect(adj.has("c")).toBe(false);
  });

  it("is empty for no edges", () => {
    expect(buildAdjacency([]).size).toBe(0);
  });

  it("addAdjacencyEdge creates the set lazily", () => {
    const adj: Adjacency = new Map();
    addAdjacencyEdge(adj, "x", "y");
    addAdjacencyEdge(adj, "x", "z");
    expect([...adj.get("x")!]).toEqual(["y", "z"]);
  });
});

describe("hasPath", () => {
  const adj = buildAdjacency([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ]);

  it("finds a direct edge", () => {
    expect(hasPath(adj, "a", "b")).toBe(true);
  });

  it("finds a transitive path", () => {
    expect(hasPath(adj, "a", "d")).toBe(true);
  });

  it("returns false when unreachable", () => {
    expect(hasPath(adj, "d", "a")).toBe(false);
  });

  it("treats a node as reaching itself", () => {
    expect(hasPath(adj, "a", "a")).toBe(true);
  });

  it("returns false for an unknown source node", () => {
    expect(hasPath(adj, "zzz", "a")).toBe(false);
  });

  it("terminates on a cyclic graph instead of looping forever", () => {
    const cyclic = buildAdjacency([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]);
    expect(hasPath(cyclic, "a", "c")).toBe(false);
    expect(hasPath(cyclic, "a", "b")).toBe(true);
  });
});

describe("wouldCreateCycle", () => {
  it("flags an edge that closes a back-path", () => {
    // a -> b -> c already; adding c -> a would cycle.
    const adj = buildAdjacency([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(wouldCreateCycle(adj, "c", "a")).toBe(true);
  });

  it("allows an edge with no back-path", () => {
    const adj = buildAdjacency([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(wouldCreateCycle(adj, "a", "d")).toBe(false);
  });

  it("flags a direct two-node cycle (a->b exists, add b->a)", () => {
    const adj = buildAdjacency([{ from: "a", to: "b" }]);
    expect(wouldCreateCycle(adj, "b", "a")).toBe(true);
  });

  it("flags a self-edge", () => {
    expect(wouldCreateCycle(new Map(), "a", "a")).toBe(true);
  });
});
