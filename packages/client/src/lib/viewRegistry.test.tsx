import { describe, it, expect } from "vitest";
import {
  VIEW_REGISTRY,
  VIEW_IDS,
  SHORTCUT_TO_VIEW,
  PRIMARY_VIEWS,
  SECONDARY_VIEWS,
  type ViewMode,
} from "./viewRegistry";
import { VIEW_ICONS } from "../components/viewIcons.js";

describe("VIEW_REGISTRY", () => {
  it("has no duplicate view ids", () => {
    const ids = VIEW_REGISTRY.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate shortcut keys", () => {
    const shortcuts = VIEW_REGISTRY.map((v) => v.shortcut).filter(Boolean);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("does not collide with global board action shortcuts", () => {
    const globalActionShortcuts = new Set(["/", "?", "a", "c", "q", "w", "x"]);
    const collidingViews = VIEW_REGISTRY.filter((v) => v.shortcut && globalActionShortcuts.has(v.shortcut));
    expect(collidingViews).toEqual([]);
  });

  it("enumerates all board views", () => {
    // 41 → 35 (#234): the seven single-chart views (throughput, lead-time,
    // burndown, provider-mix, provider-cost, agent-throughput,
    // scorecard-distribution) were absorbed into the tabbed "analytics" view.
    // 35 → 31 (#235): the six event feeds collapsed to two — "activity"
    // (+ digest & cross-repo tabs) and "runtime" (flight-recorder,
    // monitor-cycles, health-events tabs).
    // 31 → 27 (#237): the four decorative views (constellation, momentum,
    // fireworks, garden) were extracted to the external board-whimsy plugin
    // (momentum dropped outright — swimlane is a strict superset), freeing
    // the `v` and `e` single-key shortcuts.
    expect(VIEW_REGISTRY).toHaveLength(27);
  });

  it("preserves the existing view ids", () => {
    const expected: ViewMode[] = [
      "kanban", "backlog", "graph", "table", "agents", "timeline", "metrics",
      "quality-metrics", "strategy", "focus", "butler", "workflows", "workflow-analytics", "insights", "swimlane", "flaky-tests",
      "runtime", "drive", "runbooks", "capacity", "activity", "stale-work",
      "analytics", "calendar",
      "crime-scene", "milestones", "plugin-views",
    ];
    expect(VIEW_IDS.slice().sort()).toEqual(expected.slice().sort());
  });

  it("keeps at most two event-feed registry entries (#235)", () => {
    const feedIds = VIEW_IDS.filter((id) =>
      ["activity", "runtime", "digest", "cross-repo-activity", "monitor-history", "health-events", "agent-flight-recorder"].includes(id),
    );
    expect(feedIds.sort()).toEqual(["activity", "runtime"]);
  });

  it("preserves the existing view shortcuts (b/g/t/f/l/m/i/p/u/h, etc.)", () => {
    const byId = Object.fromEntries(VIEW_REGISTRY.map((v) => [v.id, v.shortcut]));
    expect(byId.kanban).toBe("b");
    expect(byId.backlog).toBe("r");
    expect(byId.graph).toBe("g");
    expect(byId.table).toBe("t");
    expect(byId.timeline).toBe("f");
    expect(byId.agents).toBe("l");
    expect(byId.metrics).toBe("m");
    expect(byId["quality-metrics"]).toBe("y");
    expect(byId.butler).toBe("i");
    expect(byId.swimlane).toBe("p");
    expect(byId.insights).toBe("n");
    expect(byId["flaky-tests"]).toBe("k");
    expect(byId.strategy).toBe("z");
    expect(byId.focus).toBe("o");
    expect(byId.workflows).toBe("u");
    expect(byId["workflow-analytics"]).toBe("h");
  });

  it("keeps the shortcuts freed by the board-whimsy extraction (v, e) unassigned (#237)", () => {
    expect(SHORTCUT_TO_VIEW["v"]).toBeUndefined();
    expect(SHORTCUT_TO_VIEW["e"]).toBeUndefined();
  });

  it("every view has the fields the three consumers need", () => {
    for (const v of VIEW_REGISTRY) {
      expect(v.id).toBeTruthy();
      expect(v.toolbarLabel).toBeTruthy();
      expect(v.label).toBeTruthy();
      expect(v.tooltip).toBeTruthy();
      // The glyph moved to components/viewIcons.tsx (#829) — lib/ may not render JSX. A test
      // file MAY reach up (the #694 scan exempts them), which is how this stays asserted.
      expect(VIEW_ICONS[v.id]).toBeTruthy();
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
    // "runtime" (#235) inherited monitor-history's former primary slot.
    expect([...primaryIds].sort()).toEqual(
      ["agents", "backlog", "butler", "calendar", "drive", "graph", "insights", "kanban", "runtime", "plugin-views", "strategy", "table", "timeline", "workflows"].sort(),
    );
    // Analytics/secondary views live behind the "More" overflow dropdown.
    expect([...secondaryIds].sort()).toEqual(
      [
        "flaky-tests", "focus", "metrics", "quality-metrics", "swimlane", "workflow-analytics",
        "runbooks", "capacity", "activity", "stale-work",
        "analytics",
        "crime-scene", "milestones",
      ].sort(),
    );
  });

  it("places the Plugins tab directly after Graph → Butler → Workflows in the primary tab order", () => {
    const order = PRIMARY_VIEWS.map((v) => v.id);
    const idx = (id: ViewMode) => order.indexOf(id);
    expect(idx("graph")).toBeLessThan(idx("butler"));
    expect(idx("butler")).toBeLessThan(idx("workflows"));
    expect(idx("plugin-views")).toBe(idx("workflows") + 1);
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
