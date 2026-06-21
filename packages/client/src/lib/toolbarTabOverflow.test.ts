import { describe, it, expect } from "vitest";
import { computeVisibleTabCount, splitToolbarViews } from "./toolbarTabOverflow.js";
import type { ViewDescriptor, ViewMode } from "./viewRegistry.js";

const view = (id: string): ViewDescriptor => ({ id } as unknown as ViewDescriptor);

describe("computeVisibleTabCount", () => {
  it("shows all tabs (no More) when everything fits", () => {
    // 3 tabs * (50+4) + overhead 8 = 170 <= 200
    expect(computeVisibleTabCount({ availableWidth: 200, tabWidths: [50, 50, 50], moreWidth: 40 })).toBe(3);
  });

  it("greedily fits tabs and reserves room for More when not all fit", () => {
    // total = 4*54 + 8 = 224 > 120, so reserve More(40)+gap(4): budget = 120-8-44 = 68
    // tab1: 68-54=14 ok (count 1); tab2: 14-54<0 stop -> 1
    expect(computeVisibleTabCount({ availableWidth: 120, tabWidths: [50, 50, 50, 50], moreWidth: 40 })).toBe(1);
  });

  it("returns 0 when not even one tab fits beside More", () => {
    expect(computeVisibleTabCount({ availableWidth: 60, tabWidths: [50, 50], moreWidth: 40 })).toBe(0);
  });

  it("honors custom gap/overhead", () => {
    expect(computeVisibleTabCount({ availableWidth: 100, tabWidths: [40, 40], moreWidth: 20, gap: 0, overhead: 0 })).toBe(2);
  });
});

describe("splitToolbarViews", () => {
  const primary = [view("board"), view("table"), view("timeline")];
  const secondary = [view("settings"), view("insights")];

  it("splits visible/overflow and builds the More menu", () => {
    const out = splitToolbarViews(primary, secondary, 2, "board" as ViewMode);
    expect(out.visiblePrimaryViews.map((v) => v.id)).toEqual(["board", "table"]);
    expect(out.overflowPrimaryViews.map((v) => v.id)).toEqual(["timeline"]);
    expect(out.moreViews.map((v) => v.id)).toEqual(["timeline", "settings", "insights"]);
    expect(out.activeMoreView).toBeUndefined();
  });

  it("finds the active view when it lives in the More menu", () => {
    const out = splitToolbarViews(primary, secondary, 2, "insights" as ViewMode);
    expect(out.activeMoreView?.id).toBe("insights");
  });
});
