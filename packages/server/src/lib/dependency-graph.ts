/**
 * Pure directed-graph primitives for the issue dependency graph.
 *
 * Cycle detection used to live inline in two places — `wouldCreateCycle`
 * (`board-column.service.ts`, single-edge add) and an inner `hasPath` helper
 * (`issue.service.ts`, batch dependency edits). Both built an adjacency map and
 * ran the same reachability DFS, so the logic drifted apart by accident waiting
 * to happen. Lifting it here keeps the two call sites on one tested
 * implementation and makes the graph math unit-testable without a database.
 */

/** Adjacency list: node id -> set of nodes it points at. */
export type Adjacency = Map<string, Set<string>>;

/** A directed edge `from -> to`. */
export interface DirectedEdge {
  from: string;
  to: string;
}

/** Add a directed edge `from -> to` to an adjacency map, creating the set lazily. */
export function addAdjacencyEdge(adj: Adjacency, from: string, to: string): void {
  let set = adj.get(from);
  if (!set) {
    set = new Set();
    adj.set(from, set);
  }
  set.add(to);
}

/** Build an adjacency map from a list of directed edges. */
export function buildAdjacency(edges: Iterable<DirectedEdge>): Adjacency {
  const adj: Adjacency = new Map();
  for (const e of edges) addAdjacencyEdge(adj, e.from, e.to);
  return adj;
}

/**
 * Reachability via iterative DFS: is `to` reachable from `from` (inclusive —
 * a node trivially reaches itself)?
 */
export function hasPath(adj: Adjacency, from: string, to: string): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const ns = adj.get(cur);
    if (ns) for (const n of ns) stack.push(n);
  }
  return false;
}

/**
 * Would adding the directed edge `issueId -> dependsOnId` introduce a cycle?
 * A cycle appears iff `dependsOnId` can already reach `issueId` through the
 * existing edges (so closing the loop back to `issueId`).
 */
export function wouldCreateCycle(adj: Adjacency, issueId: string, dependsOnId: string): boolean {
  return hasPath(adj, dependsOnId, issueId);
}
