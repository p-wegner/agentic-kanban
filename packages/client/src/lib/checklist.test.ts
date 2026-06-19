import { describe, it, expect } from "vitest";
import {
  addChecklistItem,
  toggleChecklistItem,
  removeChecklistItem,
  checklistProgress,
  type ChecklistItem,
} from "./checklist.js";

// Deterministic id generator for assertions.
function seqIdGen(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const base: ChecklistItem[] = [
  { id: "a", text: "First", completed: false },
  { id: "b", text: "Second", completed: true },
];

describe("addChecklistItem", () => {
  it("appends a trimmed, incomplete item with a generated id", () => {
    const next = addChecklistItem(base, "  Third  ", seqIdGen());
    expect(next).toEqual([...base, { id: "id-1", text: "Third", completed: false }]);
  });

  it("returns null for empty/whitespace text (nothing to add)", () => {
    expect(addChecklistItem(base, "   ")).toBeNull();
    expect(addChecklistItem(base, "")).toBeNull();
  });

  it("does not mutate the input list", () => {
    const snapshot = structuredClone(base);
    addChecklistItem(base, "x", seqIdGen());
    expect(base).toEqual(snapshot);
  });
});

describe("toggleChecklistItem", () => {
  it("flips only the targeted item's completed flag", () => {
    const next = toggleChecklistItem(base, "a");
    expect(next.find((i) => i.id === "a")?.completed).toBe(true);
    expect(next.find((i) => i.id === "b")?.completed).toBe(true);
  });

  it("is a no-op for an unknown id", () => {
    expect(toggleChecklistItem(base, "missing")).toEqual(base);
  });
});

describe("removeChecklistItem", () => {
  it("drops the targeted item", () => {
    expect(removeChecklistItem(base, "a")).toEqual([base[1]]);
  });
});

describe("checklistProgress", () => {
  it("counts done/total and reports allComplete only when non-empty and all done", () => {
    expect(checklistProgress(base)).toEqual({ done: 1, total: 2, allComplete: false });
    expect(checklistProgress([{ id: "a", text: "x", completed: true }])).toEqual({
      done: 1,
      total: 1,
      allComplete: true,
    });
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, allComplete: false });
  });
});
