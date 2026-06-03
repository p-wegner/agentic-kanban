import { describe, expect, it } from "vitest";
import { applyReorderOptimistic, computeDropSortOrder } from "./reorderIssues.js";

describe("computeDropSortOrder", () => {
  const orders = [100, 200, 300, 400];

  it("places before the first card", () => {
    expect(computeDropSortOrder(orders, 0)).toBe(0); // 100 - 100
  });

  it("places between first and second card", () => {
    expect(computeDropSortOrder(orders, 1)).toBe(150); // (100 + 200) / 2
  });

  it("places between middle cards", () => {
    expect(computeDropSortOrder(orders, 2)).toBe(250); // (200 + 300) / 2
  });

  it("places between last two cards", () => {
    expect(computeDropSortOrder(orders, 3)).toBe(350); // (300 + 400) / 2
  });

  it("places after the last card", () => {
    expect(computeDropSortOrder(orders, 4)).toBe(500); // 400 + 100
  });

  it("returns prev+1 when no integer gap exists between neighbors", () => {
    // prev=100, next=101, mid=101 >= next → falls back to prev+1=101
    expect(computeDropSortOrder([100, 101], 1)).toBe(101);
  });

  it("uses midpoint when an integer gap exists", () => {
    expect(computeDropSortOrder([100, 102], 1)).toBe(101); // (100+102)/2 = 101 < 102 ✓
  });

  it("handles a single card — before", () => {
    expect(computeDropSortOrder([500], 0)).toBe(400);
  });

  it("handles a single card — after", () => {
    expect(computeDropSortOrder([500], 1)).toBe(600);
  });

  it("handles empty list", () => {
    expect(computeDropSortOrder([], 0)).toBe(0);
  });
});

describe("applyReorderOptimistic", () => {
  function mkIssues(ids: string[], sortOrders: number[]) {
    return ids.map((id, i) => ({ id, sortOrder: sortOrders[i], title: id }));
  }

  it("moves a card to the front", () => {
    const issues = mkIssues(["a", "b", "c"], [100, 200, 300]);
    const result = applyReorderOptimistic(issues, "c", 50);
    expect(result.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("moves a card to the end", () => {
    const issues = mkIssues(["a", "b", "c"], [100, 200, 300]);
    const result = applyReorderOptimistic(issues, "a", 400);
    expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("moves a card to the middle", () => {
    const issues = mkIssues(["a", "b", "c"], [100, 200, 300]);
    const result = applyReorderOptimistic(issues, "c", 150);
    expect(result.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("preserves all issues", () => {
    const issues = mkIssues(["a", "b", "c"], [100, 200, 300]);
    const result = applyReorderOptimistic(issues, "b", 350);
    expect(result).toHaveLength(3);
  });
});
