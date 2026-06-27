// @covers workflow-engine.validate.graph [error-handling, boundary]
import { describe, it, expect } from "vitest";
import { validateGraph } from "@agentic-kanban/shared/lib/workflow-engine";

/**
 * Negative-guard coverage for the visual workflow builder's graph validator.
 *
 * The existing workflow-engine.test.ts "validateGraph" block already asserts:
 *   - disconnected/unreachable-from-start nodes
 *   - duplicate node ids
 *   - cycle detection (and the loop-edge opt-out)
 *
 * This file closes the REMAINING saved-graph guards so each keeps a graph
 * runnable: exactly-one-start, at-least-one-end, orphan-inbound (no incoming
 * edge), dead-end-outbound (no outgoing edge), edges referencing missing nodes,
 * and the parallel fork<->join pairing (both directions).
 *
 * Each case violates exactly its target guard (collateral errors, where
 * structurally unavoidable, never overlap the asserted substring), so every row
 * goes green only because its guard fires — and would go RED if that guard were
 * removed from validateGraph (mutation check).
 */
describe("validateGraph — remaining negative guards", () => {
  type Node = { id: string; name: string; nodeType: string };
  type Edge = { fromNodeId: string; toNodeId: string; isLoop?: boolean };

  const cases: Array<{
    rule: string;
    nodes: Node[];
    edges: Edge[];
    expected: string;
  }> = [
    {
      rule: "more than one start node is rejected",
      nodes: [
        { id: "a", name: "Start A", nodeType: "start" },
        { id: "b", name: "Start B", nodeType: "start" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "a", toNodeId: "e" },
        { fromNodeId: "b", toNodeId: "e" },
      ],
      expected: "A workflow must have exactly one start node (found 2).",
    },
    {
      rule: "a graph with no end node is rejected",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "n", name: "Work", nodeType: "normal" },
      ],
      // loop edge keeps "n" from also tripping the dead-end guard, isolating the missing-end error
      edges: [
        { fromNodeId: "s", toNodeId: "n" },
        { fromNodeId: "n", toNodeId: "s", isLoop: true },
      ],
      expected: "A workflow must have at least one end node.",
    },
    {
      rule: "a non-start node with no incoming edge is orphaned",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "orphan", name: "Orphan", nodeType: "normal" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "e" },
        { fromNodeId: "orphan", toNodeId: "e" },
      ],
      expected: 'Node "Orphan" is orphaned: every non-start node needs an incoming edge.',
    },
    {
      rule: "a non-end node with no outgoing edge is a dead end",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "dead", name: "Dead End", nodeType: "normal" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "dead" },
        { fromNodeId: "s", toNodeId: "e" },
      ],
      expected: 'Node "Dead End" is a dead end: every non-end node needs an outgoing edge.',
    },
    {
      rule: "an edge referencing a node that no longer exists is rejected",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "e" },
        { fromNodeId: "s", toNodeId: "ghost" },
      ],
      expected: "An edge references a node that no longer exists",
    },
    {
      rule: "a parallel-join requires a matching parallel-fork upstream",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "j", name: "Join", nodeType: "parallel-join" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "j" },
        { fromNodeId: "j", toNodeId: "e" },
      ],
      expected: "A parallel-join node requires a matching parallel-fork upstream.",
    },
    {
      rule: "a parallel-fork requires a matching parallel-join downstream",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "f", name: "Fork", nodeType: "parallel-fork" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "f" },
        { fromNodeId: "f", toNodeId: "e" },
      ],
      expected: "A parallel-fork node requires a matching parallel-join downstream.",
    },
  ];

  it.each(cases)("$rule", ({ nodes, edges, expected }) => {
    const errors = validateGraph(nodes, edges);
    expect(errors.some((e) => e.includes(expected))).toBe(true);
  });

  it("accepts a complete, well-formed graph (incl. matched fork/join) with no errors", () => {
    const errors = validateGraph(
      [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "f", name: "Fork", nodeType: "parallel-fork" },
        { id: "a", name: "Branch A", nodeType: "normal" },
        { id: "b", name: "Branch B", nodeType: "normal" },
        { id: "j", name: "Join", nodeType: "parallel-join" },
        { id: "e", name: "Done", nodeType: "end" },
      ],
      [
        { fromNodeId: "s", toNodeId: "f" },
        { fromNodeId: "f", toNodeId: "a" },
        { fromNodeId: "f", toNodeId: "b" },
        { fromNodeId: "a", toNodeId: "j" },
        { fromNodeId: "b", toNodeId: "j" },
        { fromNodeId: "j", toNodeId: "e" },
      ],
    );
    expect(errors).toEqual([]);
  });
});
