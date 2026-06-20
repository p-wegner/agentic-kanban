import { describe, it, expect } from "vitest";
import { validateBatchEdges, formatBatchEdgeResult } from "./dependency-batch.js";

const TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];

describe("validateBatchEdges", () => {
  it("returns null for valid edges", () => {
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "b", action: "add" }], TYPES)).toBeNull();
    expect(validateBatchEdges([], TYPES)).toBeNull();
  });

  it("reports the first edge missing required fields with its index", () => {
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "b", action: "add" }, { issueId: "x", action: "add" }], TYPES))
      .toBe("edges[1]: missing required fields (issueId, dependsOnId, action).");
  });

  it("rejects an invalid action", () => {
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "b", action: "toggle" }], TYPES))
      .toBe("edges[0]: action must be 'add' or 'remove'.");
  });

  it("rejects an invalid type and lists the valid ones", () => {
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "b", action: "add", type: "nope" }], TYPES))
      .toBe("edges[0]: invalid type 'nope'. Valid: depends_on, blocked_by, related_to, duplicates, parent_of, child_of");
  });

  it("rejects a self-add but allows a self-remove", () => {
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "a", action: "add" }], TYPES))
      .toBe("edges[0]: an issue cannot depend on itself.");
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "a", action: "remove" }], TYPES)).toBeNull();
  });

  it("checks required fields before action/type/self", () => {
    // missing action wins over a (would-be) self-edge check
    expect(validateBatchEdges([{ issueId: "a", dependsOnId: "a" }], TYPES))
      .toBe("edges[0]: missing required fields (issueId, dependsOnId, action).");
  });
});

describe("formatBatchEdgeResult", () => {
  const result = {
    added: 2,
    removed: 1,
    skipped: [{ edge: { issueId: "a", dependsOnId: "b" }, reason: "already exists" }],
  };

  it("returns a single JSON line in json mode", () => {
    const lines = formatBatchEdgeResult(result, true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(result);
  });

  it("renders the summary + one line per skipped edge", () => {
    expect(formatBatchEdgeResult(result, false)).toEqual([
      "Added: 2, Removed: 1, Skipped: 1",
      "  Skipped: a -> b (already exists)",
    ]);
  });

  it("omits skip lines when none were skipped", () => {
    expect(formatBatchEdgeResult({ added: 0, removed: 0, skipped: [] }, false)).toEqual([
      "Added: 0, Removed: 0, Skipped: 0",
    ]);
  });
});
