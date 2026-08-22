// @covers client.dependencyGraph.edges [ui, boundary, state-transition]
//
// #729: `GraphEdges.tsx` is the file this ticket named first — the highest measured
// change-difficulty in the client with a safety net of exactly zero. It renders every
// edge of the dependency graph in two quite different modes, and the branches that decide
// what a user sees are all conditional expressions inside one `.map`, which is why the
// file scores as hard to change.
//
// These tests pin what is DRAWN for a given graph state:
//   * an edge whose endpoints are not both on screen is dropped, not drawn to (0,0);
//   * in critical-path mode the chain is highlighted and everything else dimmed, and no
//     edge is clickable;
//   * in normal mode an edge is clickable, carries its type as a visible label, and an
//     edge flowing out of an actively-worked ticket gets the animated "unblock" overlay;
//   * a selected edge is drawn as selected even when it would otherwise be an unblock
//     flow — the two decorations must not both apply.
//
// The package has no `@testing-library/react` (see the note atop useApiResource.test.ts),
// so these are static-markup assertions; the click HANDLER's drag guard is therefore
// asserted structurally via `data-edge-id` presence rather than by dispatching a click,
// and that limitation is stated rather than worked around.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { GraphEdges } from "./GraphEdges.js";
import type { CriticalPathResult } from "../lib/criticalPath.js";
import {
  ACTIVE_GLOW_COLOR,
  CHAIN_EDGE_COLOR,
  DEPENDENCY_COLORS,
  type Dependency,
  type DependencyType,
  type Node,
} from "../lib/graphLayout.js";
import { BRAND } from "../lib/chartColors";

function issue(id: string, active: boolean): IssueWithStatus {
  return {
    id,
    title: id,
    workspaceSummary: active ? { active: 1, main: null } : undefined,
  } as unknown as IssueWithStatus;
}

function node(id: string, x: number, y: number, active = false): Node {
  return { id, x, y, issue: issue(id, active) };
}

function edge(id: string, from: string, to: string, type: DependencyType = "depends_on"): Dependency {
  return { id, issueId: to, dependsOnId: from, type, issueTitle: to, issueStatusName: "Todo", issueNumber: 1 };
}

function nodeMap(...nodes: Node[]): Map<string, Node> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function criticalPath(chain: string[]): CriticalPathResult {
  return {
    rootBlockers: [],
    cycleNodeIds: new Set(),
    chainsByRoot: new Map(),
    bestUnblock: null,
    chainNodeIds: new Set(chain),
  } as CriticalPathResult;
}

interface RenderOptions {
  edges: Dependency[];
  nodes: Node[];
  criticalPathResult?: CriticalPathResult | null;
  selectedChainRoot?: string | null;
  selectedChainEdgeKeys?: Set<string>;
  selectedEdge?: Dependency | null;
}

function render(opts: RenderOptions): string {
  return renderToStaticMarkup(
    <svg>
      <GraphEdges
        edges={opts.edges}
        nodeMap={nodeMap(...opts.nodes)}
        isCriticalPathMode={opts.criticalPathResult != null}
        criticalPathResult={opts.criticalPathResult ?? null}
        selectedChainRoot={opts.selectedChainRoot ?? null}
        selectedChainEdgeKeys={opts.selectedChainEdgeKeys ?? new Set()}
        selectedEdge={opts.selectedEdge ?? null}
        didDragRef={{ current: false }}
        onEdgeClick={() => {}}
      />
    </svg>,
  );
}

/** The `stroke` of the visible (non-hit-target, non-overlay) path for one edge. */
function strokesOf(html: string): string[] {
  return [...html.matchAll(/stroke="([^"]+)"/g)].map((m) => m[1]);
}

function opacitiesOf(html: string): number[] {
  return [...html.matchAll(/opacity="([^"]+)"/g)].map((m) => Number(m[1]));
}

const a = node("a", 0, 0);
const b = node("b", 400, 0);

describe("GraphEdges — endpoints that are not on screen", () => {
  it("draws nothing for an edge whose source node is missing", () => {
    // A filtered-out or collapsed node must not leave an edge dangling at the origin.
    const html = render({ edges: [edge("e1", "ghost", "b")], nodes: [b] });
    expect(html).not.toContain("data-edge-id");
    expect(html).toBe("<svg></svg>");
  });

  it("draws nothing for an edge whose target node is missing", () => {
    const html = render({ edges: [edge("e1", "a", "ghost")], nodes: [a] });
    expect(html).toBe("<svg></svg>");
  });

  it("still draws the edges whose endpoints ARE present", () => {
    const html = render({
      edges: [edge("dangling", "a", "ghost"), edge("real", "a", "b")],
      nodes: [a, b],
    });
    expect(html).toContain('data-edge-id="real"');
    expect(html).not.toContain('data-edge-id="dangling"');
  });
});

describe("GraphEdges — dependency mode", () => {
  it("colours an edge by its dependency type and labels it in words", () => {
    const html = render({ edges: [edge("e1", "a", "b", "related_to")], nodes: [a, b] });
    expect(strokesOf(html)).toContain(DEPENDENCY_COLORS.related_to);
    // The user reads the relationship off the graph; "related to", not "related_to".
    expect(html).toContain("related to");
  });

  it("gives every edge an invisible wide hit target so it can actually be clicked", () => {
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [a, b] });
    expect(html).toContain('stroke="transparent"');
    expect(html).toContain('stroke-width="12"');
    expect(html).toContain('data-edge-id="e1"');
  });

  it("marks an edge leaving an actively-worked ticket as an unblock flow", () => {
    // The animation communicates "this ticket is being worked and will unblock that one".
    const active = node("a", 0, 0, true);
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [active, b] });
    expect(html).toContain('data-unblock-flow="true"');
    expect(html).toContain("graph-unblock-flow");
    expect(strokesOf(html)).toContain(ACTIVE_GLOW_COLOR);
  });

  it("does not animate a non-blocking edge even from an active ticket", () => {
    // `related_to` implies no ordering, so there is nothing to unblock.
    const active = node("a", 0, 0, true);
    const html = render({ edges: [edge("e1", "a", "b", "related_to")], nodes: [active, b] });
    expect(html).not.toContain("data-unblock-flow");
    expect(html).not.toContain("graph-unblock-flow");
  });

  it("does not animate an edge from an idle ticket", () => {
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [a, b] });
    expect(html).not.toContain("data-unblock-flow");
  });

  it("draws the selected edge in the brand colour and drops the unblock decoration", () => {
    // Selection and the unblock animation are both highlights; showing both at once made
    // the selected edge unreadable.
    const active = node("a", 0, 0, true);
    const selected = edge("e1", "a", "b");
    const html = render({ edges: [selected], nodes: [active, b], selectedEdge: selected });
    expect(strokesOf(html)).toContain(BRAND);
    expect(html).not.toContain("graph-unblock-flow");
    expect(html).not.toContain("data-unblock-flow");
  });

  it("selects by edge id, so a different selected edge does not highlight this one", () => {
    const html = render({
      edges: [edge("e1", "a", "b")],
      nodes: [a, b],
      selectedEdge: edge("other", "a", "b"),
    });
    expect(strokesOf(html)).not.toContain(BRAND);
  });

  it("falls back to a neutral colour for an unknown dependency type", () => {
    const html = render({
      edges: [edge("e1", "a", "b", "invented_type" as DependencyType)],
      nodes: [a, b],
    });
    // An unmapped type must still render an edge rather than an unstyled/invisible one.
    expect(strokesOf(html)).toContain("#9ca3af");
    expect(html).toContain('data-edge-id="e1"');
  });
});

describe("GraphEdges — critical-path mode", () => {
  const chain = criticalPath(["a", "b"]);

  it("highlights an edge whose both ends are on the critical chain", () => {
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [a, b], criticalPathResult: chain });
    expect(strokesOf(html)).toContain(CHAIN_EDGE_COLOR);
    expect(Math.max(...opacitiesOf(html))).toBeCloseTo(0.9);
  });

  it("dims a blocking edge that is not on the chain instead of hiding it", () => {
    const off = criticalPath(["a"]);
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [a, b], criticalPathResult: off });
    expect(strokesOf(html)).not.toContain(CHAIN_EDGE_COLOR);
    // Still visible — the surrounding graph is context, not noise to remove.
    expect(opacitiesOf(html)).toEqual([0.25]);
  });

  it("dims a non-blocking edge harder than a blocking one", () => {
    const off = criticalPath([]);
    const blocking = render({ edges: [edge("e1", "a", "b")], nodes: [a, b], criticalPathResult: off });
    const related = render({ edges: [edge("e1", "a", "b", "related_to")], nodes: [a, b], criticalPathResult: off });
    expect(opacitiesOf(related)[0]).toBeLessThan(opacitiesOf(blocking)[0]);
  });

  it("makes no edge clickable in this mode", () => {
    // Selecting an edge is meaningless while the view answers "what unblocks the most".
    const html = render({ edges: [edge("e1", "a", "b")], nodes: [a, b], criticalPathResult: chain });
    expect(html).not.toContain("data-edge-id");
    expect(html).not.toContain("cursor:pointer");
  });

  it("shows no type labels in this mode", () => {
    const html = render({ edges: [edge("e1", "a", "b", "related_to")], nodes: [a, b], criticalPathResult: chain });
    expect(html).not.toContain("related to");
  });

  it("follows the SELECTED chain when the user picks a root blocker, not the global chain", () => {
    // With a root selected, "on the chain" means that root's chain — an edge in the
    // global critical set but outside the selection must dim.
    const html = render({
      edges: [edge("global", "a", "b"), edge("picked", "b", "c")],
      nodes: [a, b, node("c", 800, 0)],
      criticalPathResult: criticalPath(["a", "b"]),
      selectedChainRoot: "b",
      selectedChainEdgeKeys: new Set(["b->c"]),
    });
    // Edges render in the order given, so this says WHICH of the two is highlighted:
    // the picked chain's `b->c`, and NOT the globally-critical `a->b`.
    expect(strokesOf(html)).toEqual(["#d17d54", CHAIN_EDGE_COLOR]);
  });
});
