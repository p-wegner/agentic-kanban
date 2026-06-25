import { describe, expect, it } from "vitest";
import {
  resolveCoupledComponent,
  planContraction,
  type DependencyEdge,
  type EdgeMutation,
} from "../src/lib/dependency-graph.js";
import { SYMMETRIC_DEPENDENCY_TYPES, DEPENDENCY_TYPES } from "../src/schema/index.js";

/**
 * Coupling-as-a-first-class-edge (#916). `coupled_with` is a SYMMETRIC peer edge.
 * A contracted set is a connected component of `coupled_with` edges; collapsing it
 * onto a lead must inherit the union of the set's external sequential deps and
 * repoint downstream edges, with NO dangling edge left pointing at an absorbed member.
 */

const coupled = (from: string, to: string): DependencyEdge => ({ from, to, type: "coupled_with" });
const dep = (from: string, to: string): DependencyEdge => ({ from, to, type: "depends_on" });

function findMutation(muts: EdgeMutation[], m: Omit<EdgeMutation, never>): boolean {
  return muts.some(
    (x) => x.issueId === m.issueId && x.dependsOnId === m.dependsOnId && x.type === m.type && x.action === m.action,
  );
}

describe("coupled_with is a registered symmetric dependency type", () => {
  it("is part of the canonical type set and marked symmetric", () => {
    expect(DEPENDENCY_TYPES).toContain("coupled_with");
    expect(SYMMETRIC_DEPENDENCY_TYPES.has("coupled_with")).toBe(true);
    // directional types must NOT be symmetric
    expect(SYMMETRIC_DEPENDENCY_TYPES.has("depends_on")).toBe(false);
  });
});

describe("resolveCoupledComponent", () => {
  it("returns just the issue when it has no coupling edges", () => {
    const comp = resolveCoupledComponent("A", [dep("A", "B"), dep("B", "C")]);
    expect([...comp]).toEqual(["A"]);
  });

  it("walks coupled_with edges in both directions (symmetric)", () => {
    // stored as A->B and C->B; querying from any member returns the whole component
    const edges = [coupled("A", "B"), coupled("C", "B")];
    expect(resolveCoupledComponent("A", edges)).toEqual(new Set(["A", "B", "C"]));
    expect(resolveCoupledComponent("B", edges)).toEqual(new Set(["A", "B", "C"]));
    expect(resolveCoupledComponent("C", edges)).toEqual(new Set(["A", "B", "C"]));
  });

  it("ignores non-coupling edge types", () => {
    const edges = [coupled("A", "B"), dep("B", "X"), { from: "A", to: "Y", type: "related_to" }];
    expect(resolveCoupledComponent("A", edges)).toEqual(new Set(["A", "B"]));
  });

  it("resolves transitive chains across multiple hops", () => {
    const edges = [coupled("A", "B"), coupled("B", "C"), coupled("C", "D")];
    expect(resolveCoupledComponent("A", edges)).toEqual(new Set(["A", "B", "C", "D"]));
  });

  it("keeps disjoint coupling components separate", () => {
    const edges = [coupled("A", "B"), coupled("X", "Y")];
    expect(resolveCoupledComponent("A", edges)).toEqual(new Set(["A", "B"]));
    expect(resolveCoupledComponent("X", edges)).toEqual(new Set(["X", "Y"]));
  });
});

describe("planContraction edge inheritance", () => {
  it("repoints an external depends_on pointing AT an absorbed member onto the lead", () => {
    // A,B coupled; lead = A. External issue E depends_on B. After contraction E depends_on A.
    const edges = [coupled("A", "B"), dep("E", "B")];
    const muts = planContraction("A", ["A", "B"], edges);

    // old edge to the absorbed member is removed (no dangling)
    expect(findMutation(muts, { issueId: "E", dependsOnId: "B", type: "depends_on", action: "remove" })).toBe(true);
    // repointed onto the lead
    expect(findMutation(muts, { issueId: "E", dependsOnId: "A", type: "depends_on", action: "add" })).toBe(true);
    // internal coupling edge dropped
    expect(findMutation(muts, { issueId: "A", dependsOnId: "B", type: "coupled_with", action: "remove" })).toBe(true);
  });

  it("absorbs the UNION of the set's external depends_on edges onto the lead", () => {
    // A,B coupled; lead = A. A depends_on X, B depends_on Y. Lead must end up depending on X and Y.
    const edges = [coupled("A", "B"), dep("A", "X"), dep("B", "Y")];
    const muts = planContraction("A", ["A", "B"], edges);

    // B depends_on Y is repointed → A depends_on Y
    expect(findMutation(muts, { issueId: "B", dependsOnId: "Y", type: "depends_on", action: "remove" })).toBe(true);
    expect(findMutation(muts, { issueId: "A", dependsOnId: "Y", type: "depends_on", action: "add" })).toBe(true);

    // A depends_on X already lives on the lead — left untouched (not removed)
    expect(findMutation(muts, { issueId: "A", dependsOnId: "X", type: "depends_on", action: "remove" })).toBe(false);
  });

  it("does not re-add a lead edge that already exists (no duplicates, no dangling)", () => {
    // Both A and B depend_on X; lead = A. B's edge repoints to A, but A->X already exists.
    const edges = [coupled("A", "B"), dep("A", "X"), dep("B", "X")];
    const muts = planContraction("A", ["A", "B"], edges);

    expect(findMutation(muts, { issueId: "B", dependsOnId: "X", type: "depends_on", action: "remove" })).toBe(true);
    // no duplicate add of A->X
    const addsOfAX = muts.filter(
      (m) => m.action === "add" && m.issueId === "A" && m.dependsOnId === "X" && m.type === "depends_on",
    );
    expect(addsOfAX).toHaveLength(0);
  });

  it("leaves edges wholly internal to the component alone (except the coupling itself)", () => {
    // A,B coupled and A depends_on B (internal). The internal depends_on is NOT repointed.
    const edges = [coupled("A", "B"), dep("A", "B")];
    const muts = planContraction("A", ["A", "B"], edges);

    // internal depends_on between members must not be touched
    expect(findMutation(muts, { issueId: "A", dependsOnId: "B", type: "depends_on", action: "remove" })).toBe(false);
    // but the coupling edge is dropped
    expect(findMutation(muts, { issueId: "A", dependsOnId: "B", type: "coupled_with", action: "remove" })).toBe(true);
  });

  it("inherits blocked_by edges too and never produces a self-edge", () => {
    const edges = [coupled("A", "B"), { from: "B", to: "Z", type: "blocked_by" }];
    const muts = planContraction("A", ["A", "B"], edges);
    expect(findMutation(muts, { issueId: "B", dependsOnId: "Z", type: "blocked_by", action: "remove" })).toBe(true);
    expect(findMutation(muts, { issueId: "A", dependsOnId: "Z", type: "blocked_by", action: "add" })).toBe(true);
    // no mutation may ever be a self-edge
    expect(muts.every((m) => m.issueId !== m.dependsOnId)).toBe(true);
  });

  it("does not repoint related_to / topical edges (only sequential deps inherit)", () => {
    const edges = [coupled("A", "B"), { from: "E", to: "B", type: "related_to" }];
    const muts = planContraction("A", ["A", "B"], edges);
    expect(findMutation(muts, { issueId: "E", dependsOnId: "B", type: "related_to", action: "remove" })).toBe(false);
  });
});
