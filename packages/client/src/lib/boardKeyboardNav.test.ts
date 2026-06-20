import { describe, it, expect } from "vitest";
import { computeNavTarget, type NavColumn } from "./boardKeyboardNav.js";

const cols: NavColumn[] = [
  { issues: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
  { issues: [] },
  { issues: [{ id: "c1" }, { id: "c2" }] },
];

describe("computeNavTarget", () => {
  it("seeds onto the first issue of the first non-empty column when cursor is unset", () => {
    expect(computeNavTarget(cols, null, "ArrowDown")).toBe("a1");
    expect(computeNavTarget(cols, "missing", "ArrowUp")).toBe("a1");
  });

  it("returns null when there is no navigable issue at all", () => {
    expect(computeNavTarget([{ issues: [] }], null, "j")).toBeNull();
    expect(computeNavTarget([], null, "ArrowRight")).toBeNull();
  });

  it("moves down/up within a column (arrows and vim keys equivalent)", () => {
    expect(computeNavTarget(cols, "a1", "ArrowDown")).toBe("a2");
    expect(computeNavTarget(cols, "a1", "j")).toBe("a2");
    expect(computeNavTarget(cols, "a2", "ArrowUp")).toBe("a1");
    expect(computeNavTarget(cols, "a2", "k")).toBe("a1");
  });

  it("clamps at column edges (stays put)", () => {
    expect(computeNavTarget(cols, "a3", "ArrowDown")).toBe("a3");
    expect(computeNavTarget(cols, "a1", "ArrowUp")).toBe("a1");
  });

  it("skips empty columns when moving horizontally and clamps the row index", () => {
    // From a3 (row 2) moving right skips the empty column and clamps to c2 (row 1).
    expect(computeNavTarget(cols, "a3", "ArrowRight")).toBe("c2");
    expect(computeNavTarget(cols, "a3", "l")).toBe("c2");
    // From c1 moving left skips the empty column back to column a, same row.
    expect(computeNavTarget(cols, "c1", "ArrowLeft")).toBe("a1");
    expect(computeNavTarget(cols, "c2", "h")).toBe("a2");
  });

  it("stays put when there is no column in the horizontal direction", () => {
    expect(computeNavTarget(cols, "a1", "ArrowLeft")).toBe("a1");
    expect(computeNavTarget(cols, "c1", "ArrowRight")).toBe("c1");
  });
});
