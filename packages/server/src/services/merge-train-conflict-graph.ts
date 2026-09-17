/**
 * Conflict-aware train assembly (#1191).
 *
 * `assembleMergeTrain` used to merge members in PLAN order and drop whichever one first
 * conflicted with the train so far — so a member that conflicts with an EARLIER member (not
 * with the base) got dropped purely because of where it landed in the list, and a bisect on a
 * red gate re-discovered the exact same pairwise conflicts at every level of the split. Measured
 * on the one landed train so far (13 members): 17 drops fell into 5 file clusters, i.e. the same
 * handful of member-vs-member collisions were rediscovered over and over rather than being
 * computed once.
 *
 * This module computes the conflict graph ONCE, up front, via read-only `merge-tree`
 * (`detectConflictsByBranch` — never touches a working tree, safe to run for every pair before
 * any assembly happens), then:
 *  - picks a maximum conflict-free SET as the train to build this round (`pickConflictFreeSet`),
 *  - orders that set for stacking by LEAST OVERLAP against the rest of the picked set
 *    (`orderByLeastOverlap`, proposal 2026-08-25 §4.3), so the members most likely to still
 *    collide with the base or with a dropped sibling are merged last, and
 *  - reports the excluded members with the SPECIFIC member each one conflicts with, not just a
 *    generic "conflict" reason — so both a human reading the drop and `propose_ticket_groups`
 *    have something to act on.
 *
 * The pairwise check is CACHED PER TIP PAIR (process-wide, bounded): `merge-tree A B` depends
 * only on the two commits, so a bisect's sub-attempts — which re-assemble subsets of the same
 * members against the same tips — pay for each pair once per train instead of once per level.
 *
 * Deliberately pure and synchronous EXCEPT for the pairwise conflict check, which is the one
 * thing that must ask git — everything downstream (set selection, ordering, cluster reporting)
 * is a graph algorithm over the resulting adjacency and is unit-testable without a repo.
 */
import { detectConflictsByBranch, revParse } from "@agentic-kanban/shared/lib/git-service";

export interface ConflictGraphMember {
  workspaceId: string;
  branch: string;
  issueNumber?: number | null;
}

/** One detected pairwise conflict between two members' branches (base-independent — a-vs-b, not vs base). */
export interface MemberConflictEdge {
  a: string;
  b: string;
  files: string[];
}

export interface ConflictGraph {
  /** Every pairwise conflict found, for reporting/clustering. */
  edges: MemberConflictEdge[];
  /** workspaceId -> ids of every member it conflicts with. */
  adjacency: Map<string, Set<string>>;
}

/** The git side of `computeConflictGraph`, injectable so the cache can be unit-tested without a repo. */
export interface ConflictGraphIo {
  /** `merge-tree` of two branches: does git auto-resolve their union? */
  detect: (repoPath: string, featureBranch: string, targetBranch: string) => Promise<{ hasConflicts: boolean; conflictingFiles: string[] }>;
  /** The commit a branch points at — the cache key, since `merge-tree` depends on nothing else. */
  resolveTip: (repoPath: string, branch: string) => Promise<string>;
}

const defaultIo: ConflictGraphIo = { detect: detectConflictsByBranch, resolveTip: revParse };

/**
 * `merge-tree A B` is a pure function of the two commits, so its verdict is cached by the
 * (unordered) tip pair for the life of the process. Bounded FIFO: a train of n members inserts
 * n(n-1)/2 keys, so the cap is a few hundred trains' worth before the oldest are evicted.
 */
const PAIR_CACHE_MAX = 4096;
const pairConflictCache = new Map<string, { hasConflicts: boolean; files: string[] }>();

function pairKey(tipA: string, tipB: string): string {
  return tipA < tipB ? `${tipA}|${tipB}` : `${tipB}|${tipA}`;
}

function rememberPair(key: string, value: { hasConflicts: boolean; files: string[] }): void {
  if (pairConflictCache.size >= PAIR_CACHE_MAX) {
    const oldest = pairConflictCache.keys().next().value;
    if (oldest !== undefined) pairConflictCache.delete(oldest);
  }
  pairConflictCache.set(key, value);
}

/** Test seam: forget every cached pair verdict. */
export function clearPairConflictCache(): void {
  pairConflictCache.clear();
}

/**
 * Compute the full pairwise conflict graph for `members` — one read-only `merge-tree` per
 * unordered pair whose tip pair has not been seen before. A pair whose conflict check itself
 * errors (an unresolvable branch, e.g.) is treated as conflicting, so a member assembly could
 * not have merged anyway is excluded rather than optimistically included and failing loudly
 * later; such a verdict is NOT cached, since the next call may find the branch repaired.
 *
 * This is member-vs-member only. Conflicts against the BASE are the assembly's own business:
 * `assembleMergeTrain` still merges each kept member onto the train ref and drops what fails.
 */
export async function computeConflictGraph(
  repoPath: string,
  members: ConflictGraphMember[],
  io: ConflictGraphIo = defaultIo,
): Promise<ConflictGraph> {
  const edges: MemberConflictEdge[] = [];
  const adjacency = new Map<string, Set<string>>();
  for (const m of members) adjacency.set(m.workspaceId, new Set());

  const tips = new Map<string, string | null>();
  for (const m of members) {
    tips.set(m.workspaceId, await io.resolveTip(repoPath, m.branch).catch(() => null));
  }

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      const tipA = tips.get(a.workspaceId);
      const tipB = tips.get(b.workspaceId);
      const key = tipA && tipB ? pairKey(tipA, tipB) : null;
      let verdict = key ? pairConflictCache.get(key) : undefined;
      if (!verdict) {
        try {
          // `detect(repo, feature, target)` merges feature onto target. Which side is which is
          // arbitrary here: a three-way merge of two commits conflicts in either direction.
          const result = await io.detect(repoPath, b.branch, a.branch);
          verdict = { hasConflicts: result.hasConflicts, files: result.conflictingFiles };
          if (key) rememberPair(key, verdict);
        } catch {
          verdict = { hasConflicts: true, files: [] };
        }
      }
      if (verdict.hasConflicts) {
        edges.push({ a: a.workspaceId, b: b.workspaceId, files: verdict.files });
        adjacency.get(a.workspaceId)!.add(b.workspaceId);
        adjacency.get(b.workspaceId)!.add(a.workspaceId);
      }
    }
  }
  return { edges, adjacency };
}

/**
 * Take a maximum conflict-free SUBSET of `members`: visit them by ascending conflict degree
 * (ties in the caller's order) and keep each one that conflicts with nothing kept so far.
 * Greedy rather than exact maximum-independent-set — that is NP-hard in general and the batches
 * here are small (a handful to a few dozen), where greedy-by-degree is the standard
 * good-enough heuristic and stays O(n^2). A member with no conflicts is never excluded.
 *
 * Returns the kept set in the CALLER's order (`orderByLeastOverlap` decides stacking order)
 * and the excluded members, each with the KEPT member that blocked it — a member is only ever
 * excluded because something already kept conflicts with it, so the reason always names a
 * member that is actually riding this train.
 */
export function pickConflictFreeSet(
  members: ConflictGraphMember[],
  graph: ConflictGraph,
): {
  kept: ConflictGraphMember[];
  excluded: Array<{ member: ConflictGraphMember; conflictsWith: ConflictGraphMember }>;
} {
  const byId = new Map(members.map((m) => [m.workspaceId, m]));
  const order = [...members].sort(
    (x, y) => (graph.adjacency.get(x.workspaceId)?.size ?? 0) - (graph.adjacency.get(y.workspaceId)?.size ?? 0),
  );

  const keptIds = new Set<string>();
  const excluded: Array<{ member: ConflictGraphMember; conflictsWith: ConflictGraphMember }> = [];
  for (const candidate of order) {
    const conflicts = graph.adjacency.get(candidate.workspaceId) ?? new Set<string>();
    const blockedBy = [...conflicts].find((id) => keptIds.has(id));
    if (blockedBy) {
      excluded.push({ member: candidate, conflictsWith: byId.get(blockedBy)! });
      continue;
    }
    keptIds.add(candidate.workspaceId);
  }
  const kept = members.filter((m) => keptIds.has(m.workspaceId));
  return { kept, excluded };
}

/**
 * Order `members` for stacking onto the train tip: repeatedly pick the member with the fewest
 * remaining conflicts against whatever is still unordered, ties broken by fewest conflicts in
 * the WHOLE graph (proposal 2026-08-25 §4.3), then by the caller's order. The set a train
 * actually stacks is conflict-free among itself (`pickConflictFreeSet`), so in practice the
 * order is the total-degree one: a member that collided with a deferred sibling goes last, and
 * whatever residual, base-only conflict exists surfaces on the member most likely to actually
 * cause it — not on whichever ticket happened to be requested first. Stacking is by `--no-ff`
 * merge onto the tip; nothing here rebases a member branch.
 */
export function orderByLeastOverlap(members: ConflictGraphMember[], graph: ConflictGraph): ConflictGraphMember[] {
  if (members.length <= 1) return [...members];
  const remaining = new Set(members.map((m) => m.workspaceId));
  const byId = new Map(members.map((m) => [m.workspaceId, m]));
  const ordered: ConflictGraphMember[] = [];

  while (remaining.size > 0) {
    let bestId: string | null = null;
    let bestScore = Infinity;
    let bestDegree = Infinity;
    for (const id of remaining) {
      const conflicts = graph.adjacency.get(id) ?? new Set();
      let score = 0;
      for (const other of remaining) {
        if (other !== id && conflicts.has(other)) score++;
      }
      const degree = conflicts.size;
      if (score < bestScore || (score === bestScore && degree < bestDegree)) {
        bestScore = score;
        bestDegree = degree;
        bestId = id;
      }
    }
    if (!bestId) break;
    remaining.delete(bestId);
    ordered.push(byId.get(bestId)!);
  }
  return ordered;
}

/**
 * Connected components of the conflict graph, restricted to `memberIds` — the clusters worth
 * feeding to `propose_ticket_groups`/`group-scan` as candidate `coupled_with` groups (decision
 * 015): tickets that collide on every train attempt are coupled tickets in disguise. Singletons
 * (no conflicts at all) are omitted — nothing to propose.
 */
export function conflictClusters(memberIds: string[], graph: ConflictGraph): string[][] {
  const idSet = new Set(memberIds);
  const visited = new Set<string>();
  const clusters: string[][] = [];
  for (const id of memberIds) {
    if (visited.has(id)) continue;
    const neighbours = graph.adjacency.get(id);
    if (!neighbours || neighbours.size === 0) continue;
    const component: string[] = [];
    const stack = [id];
    visited.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const next of graph.adjacency.get(cur) ?? []) {
        if (!idSet.has(next) || visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (component.length >= 2) clusters.push(component);
  }
  return clusters;
}
