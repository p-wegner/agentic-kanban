import { describe, expect, it } from "vitest";
import {
  computeCouplingCandidates,
  couplingCandidatesFor,
  couplingComponents,
  DEFAULT_COUPLING_OVERLAP_THRESHOLD,
  type IssueTouchedFiles,
} from "../src/lib/coupling-overlap.js";

/**
 * Deterministic touched-file overlap → coupling-candidate detection (#917).
 * The "detect" half of the contraction epic: backlog tickets whose AI-predicted
 * touched files overlap above a configurable threshold are coupling candidates
 * (a `coupled_with` suggestion). Pure, propose-only, threshold-configurable.
 */

const issue = (id: string, files: string[]): IssueTouchedFiles => ({ issueId: id, files });

describe("computeCouplingCandidates", () => {
  it("surfaces a pair that shares files above the threshold", () => {
    const candidates = computeCouplingCandidates([
      issue("A", ["src/x.ts", "src/y.ts"]),
      issue("B", ["src/x.ts", "src/y.ts"]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueIds).toEqual(["A", "B"]);
    expect(candidates[0].sharedFiles).toEqual(["src/x.ts", "src/y.ts"]);
    expect(candidates[0].overlapScore).toBe(1);
  });

  it("does not surface a pair below the threshold", () => {
    // A touches 4 files, B touches 4, sharing 1 → overlap over smaller set = 1/4 = 0.25 < 0.5
    const candidates = computeCouplingCandidates([
      issue("A", ["a.ts", "b.ts", "c.ts", "shared.ts"]),
      issue("B", ["d.ts", "e.ts", "f.ts", "shared.ts"]),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("uses the smaller set as the denominator (overlap coefficient)", () => {
    // small ticket fully contained in a larger one's footprint scores 1.0
    const candidates = computeCouplingCandidates([
      issue("small", ["shared.ts"]),
      issue("big", ["shared.ts", "a.ts", "b.ts", "c.ts"]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].overlapScore).toBe(1);
    expect(candidates[0].sharedFiles).toEqual(["shared.ts"]);
  });

  it("honours a configurable threshold", () => {
    const issues = [
      issue("A", ["a.ts", "b.ts", "shared.ts"]),
      issue("B", ["c.ts", "d.ts", "shared.ts"]),
    ];
    // 1 shared / 3 = 0.333
    expect(computeCouplingCandidates(issues, { threshold: 0.5 })).toHaveLength(0);
    expect(computeCouplingCandidates(issues, { threshold: 0.3 })).toHaveLength(1);
  });

  it("ignores issues with no predicted files", () => {
    const candidates = computeCouplingCandidates([
      issue("A", ["x.ts"]),
      issue("B", []),
      issue("C", ["x.ts"]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueIds).toEqual(["A", "C"]);
  });

  it("normalises path slashes so windows/posix forms match", () => {
    const candidates = computeCouplingCandidates([
      issue("A", ["src\\x.ts"]),
      issue("B", ["src/x.ts"]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sharedFiles).toEqual(["src/x.ts"]);
  });

  it("sorts candidates by descending overlap then by issue id", () => {
    const candidates = computeCouplingCandidates([
      issue("A", ["s.ts", "a1.ts"]),       // A∩B = {s} over min(2,2)=0.5
      issue("B", ["s.ts", "b1.ts"]),
      issue("C", ["s.ts"]),                 // A∩C = {s}/1 = 1.0, B∩C = 1.0
    ]);
    // C-pairs (1.0) come before A/B pair (0.5)
    expect(candidates[0].overlapScore).toBe(1);
    expect(candidates[candidates.length - 1].overlapScore).toBe(0.5);
  });

  it("defaults the threshold to 0.5", () => {
    expect(DEFAULT_COUPLING_OVERLAP_THRESHOLD).toBe(0.5);
  });
});

describe("couplingCandidatesFor", () => {
  it("returns the other-issue view for a given target, either position", () => {
    const all = computeCouplingCandidates([
      issue("A", ["x.ts"]),
      issue("B", ["x.ts"]),
      issue("C", ["x.ts"]),
    ]);
    const forB = couplingCandidatesFor("B", all);
    const others = forB.map((c) => c.otherIssueId).sort();
    expect(others).toEqual(["A", "C"]);
    for (const c of forB) {
      expect(c.sharedFiles).toEqual(["x.ts"]);
      expect(c.overlapScore).toBe(1);
    }
  });

  it("returns nothing for an issue not in any candidate", () => {
    const all = computeCouplingCandidates([
      issue("A", ["x.ts"]),
      issue("B", ["x.ts"]),
    ]);
    expect(couplingCandidatesFor("Z", all)).toEqual([]);
  });
});

/**
 * `couplingComponents` (#918) — enumerate ALL connected components of the `coupled_with`
 * peer graph project-wide (no seed). The contract step's discovery primitive; the
 * undirected-graph inverse of the `parent_of`/`child_of` tree decompose produces.
 */
describe("couplingComponents", () => {
  const edge = (issueId: string, dependsOnId: string) => ({ issueId, dependsOnId });

  it("returns nothing when there are no coupled edges", () => {
    expect(couplingComponents([])).toEqual([]);
  });

  it("groups a transitive chain into one component, sorted", () => {
    const comps = couplingComponents([edge("B", "C"), edge("A", "B")]);
    expect(comps).toEqual([["A", "B", "C"]]);
  });

  it("walks edges in both directions (symmetric)", () => {
    // stored as A->B and C->B; the whole set is one component
    expect(couplingComponents([edge("A", "B"), edge("C", "B")])).toEqual([["A", "B", "C"]]);
  });

  it("keeps disjoint components separate and orders them largest-first", () => {
    const comps = couplingComponents([edge("X", "Y"), edge("A", "B"), edge("B", "C")]);
    expect(comps).toEqual([["A", "B", "C"], ["X", "Y"]]);
  });

  it("excludes singletons (an issue with no coupled edge is never a component)", () => {
    // D has no edge at all; only the A-B pair is a component
    expect(couplingComponents([edge("A", "B")])).toEqual([["A", "B"]]);
  });

  it("is deterministic regardless of edge input order", () => {
    const a = couplingComponents([edge("A", "B"), edge("C", "D"), edge("B", "C")]);
    const b = couplingComponents([edge("B", "C"), edge("C", "D"), edge("A", "B")]);
    expect(a).toEqual(b);
    expect(a).toEqual([["A", "B", "C", "D"]]);
  });
});
