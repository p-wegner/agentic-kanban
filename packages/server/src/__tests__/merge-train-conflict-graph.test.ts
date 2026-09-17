import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPairConflictCache,
  computeConflictGraph,
  conflictClusters,
  orderByLeastOverlap,
  pickConflictFreeSet,
  type ConflictGraph,
  type ConflictGraphIo,
  type ConflictGraphMember,
} from "../services/merge-train-conflict-graph.js";

/**
 * #1191 — everything downstream of `computeConflictGraph` (set selection, stacking order,
 * cluster reporting) is a pure graph algorithm and is tested here without a repo. The graph
 * itself is built by hand (`graph()` below); `computeConflictGraph`, the one function that asks
 * git, is tested below with an injected fake git for its per-tip-pair cache, and against a real
 * repo through `assembleMergeTrain` in `merge-train.test.ts`.
 */
const m = (id: string): ConflictGraphMember => ({ workspaceId: id, branch: `f-${id}`, issueNumber: null });

/** Build a symmetric conflict graph from a list of conflicting pairs. */
function graph(ids: string[], pairs: Array<[string, string]>): ConflictGraph {
  const adjacency = new Map<string, Set<string>>();
  for (const id of ids) adjacency.set(id, new Set());
  const edges = pairs.map(([a, b]) => {
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
    return { a, b, files: [] };
  });
  return { edges, adjacency };
}

describe("pickConflictFreeSet", () => {
  it("keeps everyone when there are no conflicts, in the caller's original order", () => {
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], []);
    const { kept, excluded } = pickConflictFreeSet(members, g);
    expect(kept.map((x) => x.workspaceId)).toEqual(["a", "b", "c"]);
    expect(excluded).toEqual([]);
  });

  it("excludes one side of a pairwise conflict and names the kept sibling it conflicts with", () => {
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], [["a", "c"]]);
    const { kept, excluded } = pickConflictFreeSet(members, g);
    // a and c both have degree 1; b has degree 0 and is never at risk.
    expect(kept.map((x) => x.workspaceId)).toContain("b");
    expect(excluded).toHaveLength(1);
    const [only] = excluded;
    // Exactly one of {a, c} is excluded, and it names the OTHER as the reason.
    expect(["a", "c"]).toContain(only.member.workspaceId);
    expect(only.conflictsWith.workspaceId).toBe(only.member.workspaceId === "a" ? "c" : "a");
    expect(kept.map((x) => x.workspaceId)).toContain(only.conflictsWith.workspaceId);
  });

  it("never excludes the zero-conflict member, whichever side of a tie the degree-sort visits first", () => {
    // a conflicts with c; b conflicts with nobody. Whichever of {a, c} the greedy pass keeps,
    // b (degree 0, never at risk) must always survive and the kept set must be exactly size 2.
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], [["a", "c"]]);
    const { kept } = pickConflictFreeSet(members, g);
    expect(kept.map((x) => x.workspaceId)).toContain("b");
    expect(kept).toHaveLength(2);
  });

  it("keeps both endpoints of a chain over its middle, and the middle names a kept neighbour", () => {
    // a-b-c chain: a conflicts with b, b conflicts with c. Greedy keeps the endpoints (degree 1
    // each) over the middle (degree 2) — two members ride instead of one — and b's reason
    // names a member that is actually on the train.
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const { kept, excluded } = pickConflictFreeSet(members, g);
    expect(kept.map((x) => x.workspaceId).sort()).toEqual(["a", "c"]);
    expect(excluded.map((e) => e.member.workspaceId)).toEqual(["b"]);
    expect(["a", "c"]).toContain(excluded[0].conflictsWith.workspaceId);
  });

  it("a fully-connected trio keeps exactly one and each excluded member points at a KEPT one", () => {
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"], ["a", "c"]]);
    const { kept, excluded } = pickConflictFreeSet(members, g);
    expect(kept).toHaveLength(1);
    expect(excluded).toHaveLength(2);
    for (const e of excluded) expect(e.conflictsWith.workspaceId).toBe(kept[0].workspaceId);
  });
});

describe("orderByLeastOverlap", () => {
  it("returns members unchanged when there is 0 or 1 of them", () => {
    expect(orderByLeastOverlap([], graph([], []))).toEqual([]);
    const [only] = [m("a")];
    expect(orderByLeastOverlap([only], graph(["a"], []))).toEqual([only]);
  });

  it("stacks conflict-free members first, in their original relative order", () => {
    const members = [m("a"), m("b"), m("c")];
    const g = graph(["a", "b", "c"], []);
    expect(orderByLeastOverlap(members, g).map((x) => x.workspaceId)).toEqual(["a", "b", "c"]);
  });

  it("pushes the member with the most remaining conflicts to the END of the stack", () => {
    // c conflicts with both a and b; a and b don't conflict with each other.
    const members = [m("c"), m("a"), m("b")];
    const g = graph(["a", "b", "c"], [["c", "a"], ["c", "b"]]);
    const ordered = orderByLeastOverlap(members, g).map((x) => x.workspaceId);
    expect(ordered[2]).toBe("c");
    expect(new Set(ordered.slice(0, 2))).toEqual(new Set(["a", "b"]));
  });
});

describe("conflictClusters", () => {
  it("returns nothing when there are no conflicts", () => {
    expect(conflictClusters(["a", "b", "c"], graph(["a", "b", "c"], []))).toEqual([]);
  });

  it("groups a connected component together and omits an unconnected member", () => {
    const g = graph(["a", "b", "c"], [["a", "b"]]);
    const clusters = conflictClusters(["a", "b", "c"], g);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(["a", "b"]);
  });

  it("keeps two disjoint conflict clusters separate", () => {
    const g = graph(["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]);
    const clusters = conflictClusters(["a", "b", "c", "d"], g).map((c) => [...c].sort());
    expect(clusters).toHaveLength(2);
    expect(clusters).toContainEqual(["a", "b"]);
    expect(clusters).toContainEqual(["c", "d"]);
  });

  it("restricts to the given member ids, ignoring conflicts with ids outside the set", () => {
    const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const clusters = conflictClusters(["a", "b"], g).map((c) => [...c].sort());
    expect(clusters).toEqual([["a", "b"]]);
  });
});

describe("computeConflictGraph — cached per tip pair", () => {
  beforeEach(() => clearPairConflictCache());

  /** Fake git: every branch's tip is its own name, and `clash` conflicts with everything. */
  function fakeIo(): ConflictGraphIo & { detect: ReturnType<typeof vi.fn> } {
    const detect = vi.fn(async (_repo: string, feature: string, target: string) => ({
      hasConflicts: feature === "f-clash" || target === "f-clash",
      conflictingFiles: feature === "f-clash" || target === "f-clash" ? ["shared.txt"] : [],
    }));
    return { detect, resolveTip: async (_repo, branch) => `tip-of-${branch}` };
  }

  it("asks git once per unordered pair and builds a symmetric adjacency", async () => {
    const io = fakeIo();
    const g = await computeConflictGraph("/repo", [m("a"), m("b"), m("clash")], io);
    expect(io.detect).toHaveBeenCalledTimes(3);
    expect([...g.adjacency.get("clash")!].sort()).toEqual(["a", "b"]);
    expect(g.adjacency.get("a")!.has("clash")).toBe(true);
    expect(g.adjacency.get("a")!.has("b")).toBe(false);
    expect(g.edges.find((e) => e.a === "a" && e.b === "clash")?.files).toEqual(["shared.txt"]);
  });

  it("a bisect's sub-attempt over the same tips pays for NO pair a second time", async () => {
    const io = fakeIo();
    await computeConflictGraph("/repo", [m("a"), m("b"), m("clash")], io);
    io.detect.mockClear();
    // The halves a bisect would re-assemble: subsets of the same members, same tips.
    const half = await computeConflictGraph("/repo", [m("a"), m("clash")], io);
    expect(io.detect).not.toHaveBeenCalled();
    expect(half.adjacency.get("a")!.has("clash")).toBe(true);
  });

  it("a member whose tip moved is re-checked, the untouched pairs are not", async () => {
    const io = fakeIo();
    await computeConflictGraph("/repo", [m("a"), m("b"), m("c")], io);
    io.detect.mockClear();
    const moved: ConflictGraphIo = { ...io, resolveTip: async (_r, branch) => (branch === "f-c" ? "tip-of-f-c-2" : `tip-of-${branch}`) };
    await computeConflictGraph("/repo", [m("a"), m("b"), m("c")], moved);
    // a-b is cached; a-c and b-c carry c's new tip and must be asked again.
    expect(io.detect).toHaveBeenCalledTimes(2);
  });

  it("treats a pair whose check throws as conflicting, without caching the failure", async () => {
    const io = fakeIo();
    io.detect.mockRejectedValueOnce(new Error("unresolvable"));
    const g = await computeConflictGraph("/repo", [m("a"), m("b")], io);
    expect(g.adjacency.get("a")!.has("b")).toBe(true);
    io.detect.mockClear();
    await computeConflictGraph("/repo", [m("a"), m("b")], io);
    expect(io.detect).toHaveBeenCalledTimes(1);
  });
});
