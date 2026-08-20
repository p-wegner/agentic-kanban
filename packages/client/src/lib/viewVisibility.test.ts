// @covers views.visibility [correctness, boundary]
//
// #233 — `VIEW_REGISTRY` holds 41 views (14 primary toolbar tabs + 27 behind "More") and had NO
// hiding mechanism anywhere in client, server or shared. Curating the toolbar meant editing
// `viewRegistry.tsx` and rebuilding, on a board whose whole premise is per-project configuration.
//
// The parsing rules below are the interesting part: this value is written by a picker, but also
// reachable from the CLI/MCP preference API, so it must degrade rather than break the toolbar.
import { describe, expect, it } from "vitest";
import {
  PRIMARY_VIEWS,
  SECONDARY_VIEWS,
  UNHIDEABLE_VIEWS,
  VIEW_IDS,
  parseHiddenViews,
  resolveVisibleView,
  serializeHiddenViews,
  visibleViews,
  type ViewMode,
} from "./viewRegistry.js";

describe("parseHiddenViews (#233)", () => {
  it("reads a JSON array of view ids", () => {
    expect(parseHiddenViews('["metrics","timeline"]')).toEqual(new Set(["metrics", "timeline"]));
  });

  it("hides nothing for absent or malformed values — never blank the toolbar", () => {
    // The pref is writable outside the picker; junk must not cost the user their views.
    for (const raw of [null, undefined, "", "not json", "{}", '"metrics"', "42"]) {
      expect(parseHiddenViews(raw).size).toBe(0);
    }
  });

  it("drops ids that are not views", () => {
    // A view removed from the registry in a later release would otherwise sit in the pref
    // forever and make the hidden count lie.
    expect(parseHiddenViews('["metrics","no-such-view"]')).toEqual(new Set(["metrics"]));
  });

  it("refuses to hide the board view even when the stored value says so", () => {
    // Guarded here, not only in the picker: a board whose last view is hidden has no way back.
    for (const locked of UNHIDEABLE_VIEWS) {
      expect(parseHiddenViews(JSON.stringify([locked, "metrics"]))).toEqual(new Set(["metrics"]));
    }
  });
});

describe("serializeHiddenViews (#233)", () => {
  it("drops the unhideable view rather than writing it", () => {
    expect(JSON.parse(serializeHiddenViews(["kanban", "metrics"] as ViewMode[]))).toEqual(["metrics"]);
  });

  it("is order-independent, so two equivalent selections produce the same string", () => {
    // Otherwise a no-op save looks like a change to anything diffing the pref.
    expect(serializeHiddenViews(["timeline", "metrics"] as ViewMode[]))
      .toBe(serializeHiddenViews(["metrics", "timeline"] as ViewMode[]));
  });

  it("round-trips through parse", () => {
    const hidden = new Set<ViewMode>(["metrics", "timeline", "runtime"]);
    expect(parseHiddenViews(serializeHiddenViews(hidden))).toEqual(hidden);
  });

  it("dedupes", () => {
    expect(JSON.parse(serializeHiddenViews(["metrics", "metrics"] as ViewMode[]))).toEqual(["metrics"]);
  });
});

describe("visibleViews (#233)", () => {
  it("returns the whole registry when nothing is hidden", () => {
    expect(visibleViews(new Set()).all.length).toBe(VIEW_IDS.length);
  });

  it("removes a hidden view from EVERY consumer's list at once", () => {
    // The five consumers (toolbar tabs, More overflow, palette, shortcut overlay, key map) all
    // derived from the registry; they now derive from one filtered answer instead of each
    // re-filtering, which is what keeps them in agreement.
    const withShortcut = PRIMARY_VIEWS.find((v) => v.shortcut && !v.chord)!;
    const result = visibleViews(new Set([withShortcut.id]));
    expect(result.all.map((v) => v.id)).not.toContain(withShortcut.id);
    expect(result.primary.map((v) => v.id)).not.toContain(withShortcut.id);
    expect(Object.values(result.shortcutToView)).not.toContain(withShortcut.id);
  });

  it("keeps the primary/secondary split intact for what remains", () => {
    const hiddenSecondary = SECONDARY_VIEWS[0];
    const result = visibleViews(new Set([hiddenSecondary.id]));
    expect(result.secondary.map((v) => v.id)).not.toContain(hiddenSecondary.id);
    expect(result.primary.length).toBe(PRIMARY_VIEWS.length);
  });

  it("never strips a shortcut belonging to a still-visible view", () => {
    const result = visibleViews(new Set(["metrics"] as ViewMode[]));
    const kanban = PRIMARY_VIEWS.find((v) => v.id === "kanban");
    if (kanban?.shortcut) expect(result.shortcutToView[kanban.shortcut]).toBe("kanban");
  });
});

describe("resolveVisibleView (#233)", () => {
  it("falls back to the board when the routed view is hidden", () => {
    // Otherwise the toolbar shows no active tab and the only escape is editing the URL.
    expect(resolveVisibleView("metrics", new Set(["metrics"] as ViewMode[]))).toBe("kanban");
  });

  it("leaves a visible view alone", () => {
    expect(resolveVisibleView("metrics", new Set())).toBe("metrics");
  });
});
