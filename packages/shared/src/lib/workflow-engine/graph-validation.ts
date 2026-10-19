

export interface GraphNodeInput {
  id: string;
  name?: string;
  nodeType: string;
}

export interface GraphEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  isLoop?: boolean;
}

type NodeNamer = (id: string) => string;

function duplicateIdError(nodes: GraphNodeInput[]): string | null {
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) duplicateIds.add(n.id);
    ids.add(n.id);
  }
  return duplicateIds.size > 0
    ? `Workflow node ids must be unique (duplicate id(s): ${[...duplicateIds].join(", ")}).`
    : null;
}

interface EdgeMaps {
  incoming: Map<string, number>;
  outgoing: Map<string, number>;
  adjacency: Map<string, string[]>;
  cycleAdjacency: Map<string, string[]>;
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildEdgeMaps(validEdges: GraphEdgeInput[]): EdgeMaps {
  const maps: EdgeMaps = { incoming: new Map(), outgoing: new Map(), adjacency: new Map(), cycleAdjacency: new Map() };
  for (const e of validEdges) {
    maps.outgoing.set(e.fromNodeId, (maps.outgoing.get(e.fromNodeId) ?? 0) + 1);
    maps.incoming.set(e.toNodeId, (maps.incoming.get(e.toNodeId) ?? 0) + 1);
    pushTo(maps.adjacency, e.fromNodeId, e.toNodeId);
    if (!e.isLoop) pushTo(maps.cycleAdjacency, e.fromNodeId, e.toNodeId);
  }
  return maps;
}

function orphanErrors(nodes: GraphNodeInput[], maps: EdgeMaps, nodeName: NodeNamer): string[] {
  const errors: string[] = [];
  for (const n of nodes) {
    if (n.nodeType !== "start" && (maps.incoming.get(n.id) ?? 0) === 0) {
      errors.push(`Node "${nodeName(n.id)}" is orphaned: every non-start node needs an incoming edge.`);
    }
  }
  for (const n of nodes) {
    if (n.nodeType !== "end" && (maps.outgoing.get(n.id) ?? 0) === 0) {
      errors.push(`Node "${nodeName(n.id)}" is a dead end: every non-end node needs an outgoing edge.`);
    }
  }
  return errors;
}

function unreachableError(nodes: GraphNodeInput[], startId: string, adjacency: Map<string, string[]>, nodeName: NodeNamer): string | null {
  const reachable = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!reachable.has(next)) stack.push(next);
    }
  }
  const disconnected = nodes.filter((n) => !reachable.has(n.id));
  if (disconnected.length === 0) return null;
  return `Disconnected workflow node(s) unreachable from start "${nodeName(startId)}": ${disconnected.map((n) => `"${nodeName(n.id)}"`).join(", ")}.`;
}

function cycleError(nodes: GraphNodeInput[], cycleAdjacency: Map<string, string[]>, nodeName: NodeNamer): string | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  let cycle: string[] | null = null;
  const dfs = (id: string): boolean => {
    visiting.add(id);
    path.push(id);
    for (const next of cycleAdjacency.get(id) ?? []) {
      if (visiting.has(next)) {
        const startIdx = path.indexOf(next);
        cycle = [...path.slice(startIdx), next];
        return true;
      }
      if (!visited.has(next) && dfs(next)) return true;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const n of nodes) {
    if (!visited.has(n.id) && dfs(n.id)) break;
  }
  const cyclePath: string[] = cycle ?? [];
  if (cyclePath.length === 0) return null;
  return `Workflow contains a cycle: ${cyclePath.map((id) => `"${nodeName(id)}"`).join(" -> ")}. Mark intentional back-edges as loop edges.`;
}

function parallelPairingErrors(nodes: GraphNodeInput[]): string[] {
  const errors: string[] = [];
  const hasFork = nodes.some((n) => n.nodeType === "parallel-fork");
  const hasJoin = nodes.some((n) => n.nodeType === "parallel-join");
  if (hasJoin && !hasFork) errors.push("A parallel-join node requires a matching parallel-fork upstream.");
  if (hasFork && !hasJoin) errors.push("A parallel-fork node requires a matching parallel-join downstream.");
  return errors;
}

/**
 * Validate a workflow graph for the builder (#83). Returns a list of human-
 * readable error strings; empty = valid.
 * Rules: exactly one start; ≥1 end; no orphan nodes (non-start needs an inbound
 * edge, non-end needs an outbound edge); edges reference real nodes; every
 * parallel-join has at least one parallel-fork in the graph.
 */
export function validateGraph(nodes: GraphNodeInput[], edges: GraphEdgeInput[]): string[] {
  const errors: string[] = [];
  if (nodes.length === 0) return ["A workflow needs at least one node."];

  const dup = duplicateIdError(nodes);
  if (dup) errors.push(dup);
  const ids = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeName: NodeNamer = (id) => nodeById.get(id)?.name?.trim() || id;
  const starts = nodes.filter((n) => n.nodeType === "start");
  const ends = nodes.filter((n) => n.nodeType === "end");
  if (starts.length !== 1) errors.push(`A workflow must have exactly one start node (found ${starts.length}).`);
  if (ends.length < 1) errors.push("A workflow must have at least one end node.");

  let hasMissingEdgeRef = false;
  for (const e of edges) {
    if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId)) {
      errors.push(`An edge references a node that no longer exists (${nodeName(e.fromNodeId)} -> ${nodeName(e.toNodeId)}).`);
      hasMissingEdgeRef = true;
    }
  }
  const maps = buildEdgeMaps(edges.filter((e) => ids.has(e.fromNodeId) && ids.has(e.toNodeId)));
  errors.push(...orphanErrors(nodes, maps, nodeName));

  if (starts.length === 1 && !hasMissingEdgeRef) {
    const unreachable = unreachableError(nodes, starts[0].id, maps.adjacency, nodeName);
    if (unreachable) errors.push(unreachable);
  }
  const cycle = cycleError(nodes, maps.cycleAdjacency, nodeName);
  if (cycle) errors.push(cycle);
  errors.push(...parallelPairingErrors(nodes));

  return errors;
}

export interface TemplateNodeInput {
  id: string; // client-side id, remapped on persist
  name: string;
  nodeType?: string;
  statusName?: string | null;
  skillId?: string | null;
  skillName?: string | null;
  maxVisits?: number;
  config?: string | null;
  posX?: number;
  posY?: number;
  sortOrder?: number;
}

export interface TemplateEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  label?: string | null;
  condition?: string;
  isLoop?: boolean;
  sortOrder?: number;
}

export interface TemplateInput {
  projectId: string;
  name: string;
  description?: string | null;
  ticketType?: string | null;
  isDefault?: boolean;
  nodes: TemplateNodeInput[];
  edges: TemplateEdgeInput[];
}

/** Validate a TemplateInput's graph; returns error strings (empty = valid). */
export function validateTemplateInput(input: { nodes: TemplateNodeInput[]; edges: TemplateEdgeInput[] }): string[] {
  return validateGraph(
    input.nodes.map((n) => ({ id: String(n.id), name: n.name, nodeType: n.nodeType ?? "normal" })),
    input.edges.map((e) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId), isLoop: !!e.isLoop })),
  );
}
