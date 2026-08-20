/**
 * Pure directed-graph primitives for the issue dependency graph.
 *
 * Cycle detection used to live inline in three places — `wouldCreateCycle`
 * (server `board-column.service.ts`, single-edge add), an inner `hasPath` helper
 * (server `issue.service.ts`, batch dependency edits), and a hand-rolled DFS in
 * the mcp-server `add_dependency` tool. All built an adjacency map and ran the
 * same reachability DFS, so the logic drifted apart by accident waiting to happen
 * (and cycle detection is correctness-critical — a miss lets a dependency loop
 * corrupt the board). Lifting it to this shared, database-free module keeps every
 * call site — across both the server and mcp-server packages — on one tested
 * implementation. Pure (no node builtins), so it is client-bundle safe.
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

// ─── Coupling (coupled_with) components + contraction edge inheritance ──────────
//
// `coupled_with` is a SYMMETRIC peer edge: two issues that touch the same code and
// are best implemented together. A "contracted set" is a connected component of the
// undirected `coupled_with` graph — when the set collapses onto a single lead issue,
// the lead must absorb the set's external dependency edges so nothing dangles.

/** A stored dependency edge (any type). `from = issueId`, `to = dependsOnId`. */
export interface DependencyEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Resolve the connected component of `coupled_with` edges containing `issueId` —
 * i.e. the full set of issues coupled to it (transitively). Always includes
 * `issueId` itself. `coupled_with` is symmetric, so edges are walked in both
 * directions regardless of the stored `(from, to)` order.
 */
export function resolveCoupledComponent(
  issueId: string,
  edges: Iterable<DependencyEdge>,
): Set<string> {
  const undirected = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = undirected.get(a);
    if (!set) { set = new Set(); undirected.set(a, set); }
    set.add(b);
  };
  for (const e of edges) {
    if (e.type !== "coupled_with") continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const component = new Set<string>([issueId]);
  const stack = [issueId];
  while (stack.length) {
    const cur = stack.pop()!;
    const ns = undirected.get(cur);
    if (!ns) continue;
    for (const n of ns) {
      if (!component.has(n)) { component.add(n); stack.push(n); }
    }
  }
  return component;
}

/** One add/remove edge operation for the `dependencies/batch` rewire. */
export interface EdgeMutation {
  issueId: string;
  dependsOnId: string;
  type: string;
  action: "add" | "remove";
}

/**
 * The set of dependency-batch mutations that atomically CONTRACT a coupled
 * component onto `leadId` (the key invariant of the contraction epic, #916).
 *
 * Given the component's members and ALL dependency edges in the project, this:
 *   1. Repoints every EXTERNAL `depends_on`/`blocked_by` edge that touches a
 *      non-lead member (in either endpoint) onto the lead — the lead absorbs the
 *      UNION of the set's external sequential edges. The old member-pointing edge
 *      is removed; the lead-pointing edge is added (deduplicated, self-edges and
 *      already-present lead edges skipped, so no dangling edges remain).
 *   2. Removes the `coupled_with` edges internal to the component (the coupling is
 *      now realized by the contraction itself).
 *
 * Edges wholly internal to the component (both endpoints are members) are NOT
 * repointed — only edges crossing the component boundary inherit. The caller feeds
 * the returned mutations to `dependencies/batch` for the atomic apply; this function
 * is pure (no DB, client-bundle safe) and fully testable.
 */
export function planContraction(
  leadId: string,
  members: Iterable<string>,
  edges: Iterable<DependencyEdge>,
): EdgeMutation[] {
  const memberSet = new Set(members);
  memberSet.add(leadId);

  const allEdges = [...edges];
  // Edges that already point at/from the lead — used to avoid re-adding duplicates.
  const existingKey = new Set(allEdges.map((e) => `${e.from}|${e.to}|${e.type}`));

  const mutations: EdgeMutation[] = [];
  const plannedAdds = new Set<string>();

  const addEdge = (from: string, to: string, type: string) => {
    if (from === to) return; // no self-edge
    const key = `${from}|${to}|${type}`;
    if (existingKey.has(key) || plannedAdds.has(key)) return;
    plannedAdds.add(key);
    mutations.push({ issueId: from, dependsOnId: to, type, action: "add" });
  };

  for (const e of allEdges) {
    const fromMember = memberSet.has(e.from);
    const toMember = memberSet.has(e.to);

    // Internal coupling edge: drop it (the contraction realizes the coupling).
    if (e.type === "coupled_with" && fromMember && toMember) {
      mutations.push({ issueId: e.from, dependsOnId: e.to, type: e.type, action: "remove" });
      continue;
    }

    // Only sequential edges inherit; topical/structural edges aren't "external deps".
    if (e.type !== "depends_on" && e.type !== "blocked_by") continue;

    // Edge wholly internal to the component, or wholly external: nothing to repoint.
    if (fromMember === toMember) continue;

    // Crosses the boundary via a NON-lead member — repoint that endpoint to the lead.
    const touchesNonLeadMember =
      (fromMember && e.from !== leadId) || (toMember && e.to !== leadId);
    if (!touchesNonLeadMember) continue;

    const newFrom = fromMember ? leadId : e.from;
    const newTo = toMember ? leadId : e.to;
    mutations.push({ issueId: e.from, dependsOnId: e.to, type: e.type, action: "remove" });
    addEdge(newFrom, newTo, e.type);
  }

  return mutations;
}

/**
 * Every node that lies ON a cycle (not merely reaches one), via an iterative DFS (#523).
 *
 * Duplicated verbatim in `dependency-auto-chain.service.ts` and
 * `dependency-wave.service.ts`, differing only in which edge types they admit — so the
 * filter is the parameter, and the traversal is shared. This module's header already
 * said inline cycle detection was the thing it existed to end; these two predate that.
 *
 * Only edges whose BOTH ends are in `nodeIds` are traversed: both callers scope the
 * graph to a working set (open issues / a wave) and must not follow an edge out of it.
 *
 * Iterative rather than recursive: the callers pass whole-project issue sets, and the
 * recursive copies would blow the stack on a long dependency chain.
 */
export function findCycleNodes<E extends DirectedEdge>(
  nodeIds: string[],
  edges: Iterable<E>,
  // Generic in the edge so a caller can filter on its OWN fields (the dependency `type`)
  // without casting at the call site — the cast is what made the copies feel unshareable.
  includeEdge: (edge: E) => boolean = () => true,
): Set<string> {
  const scoped = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (!scoped.has(edge.from) || !scoped.has(edge.to)) continue;
    if (!includeEdge(edge)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycleIds = new Set<string>();
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  // Explicit work stack: each frame is a node plus how many of its edges we have taken.
  const frames: { id: string; edgeIndex: number }[] = [];

  for (const root of nodeIds) {
    if (state.has(root)) continue;
    frames.push({ id: root, edgeIndex: 0 });
    state.set(root, "visiting");
    stack.push(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbours = adjacency.get(frame.id) ?? [];
      if (frame.edgeIndex < neighbours.length) {
        const next = neighbours[frame.edgeIndex++];
        if (state.get(next) === "visiting") {
          // Back-edge: everything from `next` up the current stack is on the cycle.
          for (const cycleId of stack.slice(stack.indexOf(next))) cycleIds.add(cycleId);
        } else if (!state.has(next)) {
          state.set(next, "visiting");
          stack.push(next);
          frames.push({ id: next, edgeIndex: 0 });
        }
        continue;
      }
      state.set(frame.id, "visited");
      stack.pop();
      frames.pop();
    }
  }
  return cycleIds;
}
