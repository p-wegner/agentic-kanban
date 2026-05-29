import dagre from "@dagrejs/dagre";

const NODE_W = 180;
const NODE_H = 48;

export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  source: string;
  target: string;
}

/**
 * Compute a human-friendly layered (top-to-bottom) layout for a workflow graph
 * using dagre. Returns a map of node id → { x, y } (top-left positions suitable
 * for react-flow). Self-loops are ignored for ranking so they don't distort it.
 */
export function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80, marginx: 20, marginy: 20 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    if (e.source === e.target) continue; // skip self-loops for ranking
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) positions.set(n.id, { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) });
  }
  return positions;
}
