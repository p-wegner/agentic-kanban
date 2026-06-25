import { describe, it, expect } from "vitest";
import { isCouplingAcrossSequentialEdge, type SequentialGuardEdge } from "../services/issue-ai.service.js";

/**
 * #916 guard: the analyzer must not auto-create a `coupled_with` peer edge between
 * two issues that already have a sequential `depends_on`/`blocked_by` edge (in either
 * direction) — that pairing is sequential by design.
 */
describe("isCouplingAcrossSequentialEdge", () => {
  const edges = (e: SequentialGuardEdge[]) => e;

  it("flags coupling when a depends_on edge exists A->B", () => {
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "A", dependsOnId: "B", type: "depends_on" }])),
    ).toBe(true);
  });

  it("flags coupling when the sequential edge runs the other direction B->A", () => {
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "B", dependsOnId: "A", type: "depends_on" }])),
    ).toBe(true);
  });

  it("flags coupling across a blocked_by edge too", () => {
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "A", dependsOnId: "B", type: "blocked_by" }])),
    ).toBe(true);
  });

  it("allows coupling when only a related_to / coupled_with edge exists", () => {
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "A", dependsOnId: "B", type: "related_to" }])),
    ).toBe(false);
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "A", dependsOnId: "B", type: "coupled_with" }])),
    ).toBe(false);
  });

  it("allows coupling when the sequential edge is to a different issue", () => {
    expect(
      isCouplingAcrossSequentialEdge("A", "B", edges([{ issueId: "A", dependsOnId: "C", type: "depends_on" }])),
    ).toBe(false);
  });

  it("allows coupling with no existing edges", () => {
    expect(isCouplingAcrossSequentialEdge("A", "B", [])).toBe(false);
  });
});
