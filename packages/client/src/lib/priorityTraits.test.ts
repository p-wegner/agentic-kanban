import { describe, it, expect } from "vitest";
import {
  ISSUE_PRIORITIES,
  PRIORITY_TRAITS,
  priorityTraits,
  priorityOrder,
  priorityLabel,
  isPlanModePriority,
} from "./priorityTraits.js";

describe("PRIORITY_TRAITS (#516)", () => {
  it("covers every canonical priority and nothing else", () => {
    expect(Object.keys(PRIORITY_TRAITS).sort()).toEqual([...ISSUE_PRIORITIES].sort());
  });

  it("has no `urgent` row — it is an input ALIAS, not a priority", () => {
    // PRIORITY_ORDER listed urgent while priorityColors and PRIORITY_LANE_STYLES did
    // not, so an urgent issue sorted top and rendered unstyled in "ungrouped".
    expect(Object.keys(PRIORITY_TRAITS)).not.toContain("urgent");
  });

  it("orders critical -> high -> medium -> low", () => {
    const byOrder = [...ISSUE_PRIORITIES].sort((a, b) => PRIORITY_TRAITS[a].order - PRIORITY_TRAITS[b].order);
    expect(byOrder).toEqual(["critical", "high", "medium", "low"]);
  });

  it("assigns a distinct rank to each priority", () => {
    const ranks = ISSUE_PRIORITIES.map((p) => PRIORITY_TRAITS[p].order);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("priority lookups fold legacy values", () => {
  it('treats a stored "urgent" as critical rather than falling through', () => {
    expect(priorityOrder("urgent")).toBe(PRIORITY_TRAITS.critical.order);
    expect(priorityLabel("urgent")).toBe("Critical");
    expect(priorityTraits("urgent").hex).toBe(PRIORITY_TRAITS.critical.hex);
  });

  it("never returns undefined traits for junk or absent input", () => {
    for (const raw of ["nonsense", "", null, undefined]) {
      expect(priorityTraits(raw as string | null)).toBeDefined();
      expect(priorityLabel(raw as string | null)).toBe("Medium");
    }
  });
});

describe("isPlanModePriority", () => {
  it("is true for critical and high only", () => {
    expect(isPlanModePriority("critical")).toBe(true);
    expect(isPlanModePriority("high")).toBe(true);
    expect(isPlanModePriority("medium")).toBe(false);
    expect(isPlanModePriority("low")).toBe(false);
  });

  it("folds the legacy alias, so an urgent issue still plans first", () => {
    expect(isPlanModePriority("urgent")).toBe(true);
  });

  it("does not plan-mode an unknown priority", () => {
    expect(isPlanModePriority("spicy")).toBe(false);
  });
});
