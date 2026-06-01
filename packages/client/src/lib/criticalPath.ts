/**
 * Critical-path analysis for dependency graphs (ticket #281).
 *
 * Pure computation module — no React dependency. Operates on the same
 * `{ nodes, edges }` shape returned by `GET /api/projects/:id/graph`.
 *
 * Blocking edge types: `depends_on` and `blocked_by` (treated identically:
 * `issueId` is blocked by `dependsOnId`).
 *
 * Uses the same resolved-status logic as `isResolvedDependencyStatusView`
 * from `@agentic-kanban/shared` (inlined to avoid shared-package build dep).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Statuses that mean a dependency is resolved / no longer blocking. */
const RESOLVED_STATUS_NAMES = new Set(["Done", "AI Reviewed", "Cancelled"]);

/** Mirrors `isResolvedDependencyStatusView` from @agentic-kanban/shared. */
function isResolvedStatus(issue: IssueLike): boolean {
  if (issue.currentNodeId != null) {
    // Workflow-driven issues: resolved if the node type is "end".
    // We don't have nodeType directly on IssueLike in the client graph data,
    // so fall back to status name.
    return RESOLVED_STATUS_NAMES.has(issue.statusName ?? "");
  }
  return RESOLVED_STATUS_NAMES.has(issue.statusName ?? "");
}

export interface Dependency {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
}

export interface IssueLike {
  id: string;
  isBlocked?: boolean;
  statusName?: string | null;
  title?: string;
  issueNumber?: number | null;
  currentNodeId?: string | null;
  currentNodeType?: string | null;
}

export interface ChainStep {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  isBlocked: boolean;
}

export interface RootBlocker {
  id: string;
  downstreamCount: number;
  chainLength: number;
}

export interface CriticalPathResult {
  /** Unresolved root blockers (block others, not themselves blocked). */
  rootBlockers: RootBlocker[];
  /** Nodes participating in cycles — excluded from chain computation. */
  cycleNodeIds: Set<string>;
  /** Longest blocking chain from each root blocker. */
  chainsByRoot: Map<string, ChainStep[]>;
  /** The root blocker whose resolution would unblock the most downstream work. */
  bestUnblock: RootBlocker | null;
  /** All nodes that are part of any blocking chain (transitively blocked). */
  chainNodeIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build forward/reverse adjacency for blocking edges only. */
function buildBlockingAdjacency(
  nodes: IssueLike[],
  edges: Dependency[],
): { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const n of nodes) {
    forward.set(n.id, new Set());
    reverse.set(n.id, new Set());
  }

  for (const e of edges) {
    if (e.type !== "depends_on" && e.type !== "blocked_by") continue;
    if (!nodeMap.has(e.issueId) || !nodeMap.has(e.dependsOnId)) continue;

    // Is the blocker resolved? If so, this edge is inactive.
    const blocker = nodeMap.get(e.dependsOnId)!;
    if (isResolvedStatus(blocker)) continue;

    forward.get(e.dependsOnId)?.add(e.issueId);
    reverse.get(e.issueId)?.add(e.dependsOnId);
  }

  return { forward, reverse };
}

/** DFS cycle detection. Returns set of node IDs that participate in a cycle. */
function detectCycles(
  forward: Map<string, Set<string>>,
  nodeIds: string[],
): Set<string> {
  const cycleIds = new Set<string>();
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function visit(id: string) {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of forward.get(id) ?? []) {
      if (state.get(next) === "visiting") {
        // Found a cycle — mark all nodes in the cycle
        const start = stack.indexOf(next);
        for (let i = start; i < stack.length; i++) cycleIds.add(stack[i]);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, "visited");
  }

  for (const id of nodeIds) {
    if (!state.has(id)) visit(id);
  }

  return cycleIds;
}

/** BFS from a set of roots, counting transitively reachable nodes. */
function computeDownstreamCounts(
  forward: Map<string, Set<string>>,
  rootIds: string[],
  cycleIds: Set<string>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const root of rootIds) {
    const visited = new Set<string>();
    const queue = [...(forward.get(root) ?? [])].filter((id) => !cycleIds.has(id));
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of forward.get(id) ?? []) {
        if (!cycleIds.has(next) && !visited.has(next)) queue.push(next);
      }
    }
    result.set(root, visited.size);
  }
  return result;
}

/**
 * Longest chain (by node count) from a root via forward adjacency.
 * Uses topological DP on the DAG (cycle nodes already excluded).
 */
function computeLongestChain(
  forward: Map<string, Set<string>>,
  rootId: string,
  cycleIds: Set<string>,
  nodeMap: Map<string, IssueLike>,
): { chain: ChainStep[]; length: number } {
  // Collect all reachable nodes from root
  const reachable = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of forward.get(id) ?? []) {
      if (!cycleIds.has(next)) queue.push(next);
    }
  }

  if (reachable.size <= 1) {
    // Root only
    const node = nodeMap.get(rootId);
    return {
      chain: node ? [toChainStep(node)] : [],
      length: 1,
    };
  }

  // Topological sort + longest-path DP
  const inDeg = new Map<string, number>();
  for (const id of reachable) inDeg.set(id, 0);
  for (const id of reachable) {
    for (const next of forward.get(id) ?? []) {
      if (reachable.has(next) && !cycleIds.has(next)) {
        inDeg.set(next, (inDeg.get(next) ?? 0) + 1);
      }
    }
  }

  const dist = new Map<string, number>(); // longest distance from root
  const parent = new Map<string, string | null>(); // predecessor on longest path
  for (const id of reachable) {
    dist.set(id, id === rootId ? 0 : -1);
    parent.set(id, null);
  }

  const topoQueue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) topoQueue.push(id);
  }

  while (topoQueue.length > 0) {
    const id = topoQueue.shift()!;
    for (const next of forward.get(id) ?? []) {
      if (!reachable.has(next) || cycleIds.has(next)) continue;
      const newDist = dist.get(id)! + 1;
      if (newDist > (dist.get(next) ?? -1)) {
        dist.set(next, newDist);
        parent.set(next, id);
      }
      const deg = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, deg);
      if (deg === 0) topoQueue.push(next);
    }
  }

  // Find the farthest node
  let farthest = rootId;
  let maxDist = 0;
  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      farthest = id;
    }
  }

  // Reconstruct chain from farthest back to root
  const chainIds: string[] = [];
  let cur: string | null = farthest;
  while (cur != null) {
    chainIds.unshift(cur);
    cur = parent.get(cur) ?? null;
  }

  const chain = chainIds
    .map((id) => nodeMap.get(id))
    .filter((n): n is IssueLike => n != null)
    .map(toChainStep);

  return { chain, length: chainIds.length };
}

function toChainStep(node: IssueLike): ChainStep {
  return {
    id: node.id,
    issueNumber: node.issueNumber ?? null,
    title: node.title ?? "Untitled",
    statusName: node.statusName ?? "Unknown",
    isBlocked: node.isBlocked ?? false,
  };
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Compute critical-path analysis for a set of issues and dependency edges.
 *
 * Returns root blockers, cycle nodes, chains from each root, and the
 * best-unblock candidate.
 */
export function computeCriticalPath(
  nodes: IssueLike[],
  edges: Dependency[],
): CriticalPathResult {
  if (nodes.length === 0 || edges.length === 0) {
    return {
      rootBlockers: [],
      cycleNodeIds: new Set(),
      chainsByRoot: new Map(),
      bestUnblock: null,
      chainNodeIds: new Set(),
    };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = nodes.map((n) => n.id);

  const { forward, reverse } = buildBlockingAdjacency(nodes, edges);

  // Cycle detection
  const cycleIds = detectCycles(forward, nodeIds);

  // Root blockers: have out-degree > 0 (block others), not in a cycle,
  // and not themselves blocked by an unresolved dependency
  const rootBlockerIds = nodeIds.filter((id) => {
    if (cycleIds.has(id)) return false;
    const blockedBy = reverse.get(id);
    // Has unresolved blockers of its own → not a root
    if (blockedBy && blockedBy.size > 0) return false;
    const blocks = forward.get(id);
    // Must block at least one other node
    return blocks && blocks.size > 0;
  });

  // Downstream counts
  const downstreamMap = computeDownstreamCounts(forward, rootBlockerIds, cycleIds);

  // Chains and chain lengths
  const chainsByRoot = new Map<string, ChainStep[]>();
  const chainLengthMap = new Map<string, number>();
  const chainNodeIds = new Set<string>();

  for (const rootId of rootBlockerIds) {
    const { chain, length } = computeLongestChain(forward, rootId, cycleIds, nodeMap);
    chainsByRoot.set(rootId, chain);
    chainLengthMap.set(rootId, length);
    for (const step of chain) chainNodeIds.add(step.id);
  }

  // Build root blockers array
  const rootBlockers: RootBlocker[] = rootBlockerIds.map((id) => ({
    id,
    downstreamCount: downstreamMap.get(id) ?? 0,
    chainLength: chainLengthMap.get(id) ?? 1,
  }));

  // Sort by downstream count descending (tiebreak: id for determinism)
  rootBlockers.sort((a, b) => b.downstreamCount - a.downstreamCount || a.id.localeCompare(b.id));

  // Best unblock = highest downstream count
  const bestUnblock = rootBlockers.length > 0 ? rootBlockers[0] : null;

  return {
    rootBlockers,
    cycleNodeIds: cycleIds,
    chainsByRoot,
    bestUnblock,
    chainNodeIds,
  };
}
