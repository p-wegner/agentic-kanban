import { describe, it, expect } from "vitest";
import {
  VIEW_REGISTRY,
  VIEW_IDS,
  SHORTCUT_TO_VIEW,
  PRIMARY_VIEWS,
  SECONDARY_VIEWS,
  type ViewMode,
} from "./viewRegistry";

describe("VIEW_REGISTRY", () => {
  it("has no duplicate view ids", () => {
    const ids = VIEW_REGISTRY.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate shortcut keys", () => {
    const shortcuts = VIEW_REGISTRY.map((v) => v.shortcut).filter(Boolean);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("enumerates all 15 board views", () => {
    expect(VIEW_REGISTRY).toHaveLength(15);
  });

  it("preserves the existing view ids", () => {
    const expected: ViewMode[] = [
      "kanban", "backlog", "graph", "table", "agents", "timeline", "metrics",
      "digest", "focus", "butler", "workflows", "workflow-analytics", "insights", "swimlane", "flaky-tests",
    ];
    expect(VIEW_IDS.slice().sort()).toEqual(expected.slice().sort());
  });

  it("preserves the existing view shortcuts (b/g/t/f/l/m/i/p/u/w, etc.)", () => {
    const byId = Object.fromEntries(VIEW_REGISTRY.map((v) => [v.id, v.shortcut]));
    expect(byId.kanban).toBe("b");
    expect(byId.backlog).toBe("r");
    expect(byId.graph).toBe("g");
    expect(byId.table).toBe("t");
    expect(byId.timeline).toBe("f");
    expect(byId.agents).toBe("l");
    expect(byId.metrics).toBe("m");
    expect(byId.butler).toBe("i");
    expect(byId.swimlane).toBe("p");
    expect(byId.insights).toBe("n");
    expect(byId["flaky-tests"]).toBe("k");
    expect(byId.digest).toBe("d");
    expect(byId.focus).toBe("o");
    expect(byId.workflows).toBe("u");
    expect(byId["workflow-analytics"]).toBe("w");
  });

  it("every view has the fields the three consumers need", () => {
    for (const v of VIEW_REGISTRY) {
      expect(v.id).toBeTruthy();
      expect(v.toolbarLabel).toBeTruthy();
      expect(v.label).toBeTruthy();
      expect(v.tooltip).toBeTruthy();
      expect(v.icon).toBeTruthy();
      expect(v.paletteIcon).toBeTruthy();
      expect(v.paletteDescription).toBeTruthy();
    }
  });

  it("splits views into primary tabs and secondary overflow (#109)", () => {
    // The two groups partition the registry with no overlap and no loss.
    expect(PRIMARY_VIEWS.length + SECONDARY_VIEWS.length).toBe(VIEW_REGISTRY.length);
    const primaryIds = new Set(PRIMARY_VIEWS.map((v) => v.id));
    const secondaryIds = new Set(SECONDARY_VIEWS.map((v) => v.id));
    for (const id of secondaryIds) expect(primaryIds.has(id)).toBe(false);

    // Primary views (no `group` or group === "primary") stay one click away.
    expect([...primaryIds].sort()).toEqual(
      ["agents", "backlog", "butler", "graph", "kanban", "table", "timeline"].sort(),
    );
    // Analytics/secondary views live behind the "More" overflow dropdown.
    expect([...secondaryIds].sort()).toEqual(
      ["digest", "flaky-tests", "focus", "insights", "metrics", "swimlane", "workflows", "workflow-analytics"].sort(),
    );
  });

  it("keeps every view reachable by some keyboard shortcut regardless of group", () => {
    // No view loses its shortcut by being tucked into the overflow menu.
    for (const v of SECONDARY_VIEWS) {
      if (v.shortcut && !v.chord) {
        expect(SHORTCUT_TO_VIEW[v.shortcut]).toBe(v.id);
      }
    }
  });

  it("excludes the graph chord from the plain-key shortcut map", () => {
    // graph is reached via a `g` chord (g+s -> settings), handled separately
    expect(SHORTCUT_TO_VIEW["g"]).toBeUndefined();
    expect(SHORTCUT_TO_VIEW["b"]).toBe("kanban");
    expect(SHORTCUT_TO_VIEW["r"]).toBe("backlog");
    expect(SHORTCUT_TO_VIEW["k"]).toBe("flaky-tests");
  });
});
