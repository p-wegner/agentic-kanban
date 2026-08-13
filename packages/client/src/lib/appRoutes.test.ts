import { describe, expect, it } from "vitest";
import {
  buildAppPath,
  getAppRouteTab,
  getAppRouteView,
  getViewRoutePath,
  parseAppPath,
} from "./appRoutes";
import { VIEW_IDS, type ViewMode } from "./viewRegistry";
import {
  RESERVED_ROUTE_SEGMENTS,
  VIEW_TAB_REGISTRY,
  getDefaultViewTab,
  getViewTabIds,
} from "./viewTabs";

describe("appRoutes", () => {
  it("maps key view modes to stable frontend paths", () => {
    expect(getViewRoutePath("kanban")).toBe("/board");
    expect(getViewRoutePath("butler")).toBe("/butler");
    expect(getViewRoutePath("workflows")).toBe("/workflows");
    expect(getViewRoutePath("agents")).toBe("/agents");
    expect(getViewRoutePath("crime-scene")).toBe("/crime-scene");
    expect(getViewRoutePath("milestones")).toBe("/milestones");
    expect(getViewRoutePath("swimlane")).toBe("/swimlane");
    expect(getViewRoutePath("plugin-views")).toBe("/plugin-views");
  });

  it("parses direct links for key views", () => {
    expect(getAppRouteView("/")).toBe("kanban");
    expect(getAppRouteView("/board")).toBe("kanban");
    expect(getAppRouteView("/workflows")).toBe("workflows");
    expect(getAppRouteView("/butler")).toBe("butler");
    expect(getAppRouteView("/quality-metrics?project=abc")).toBe("quality-metrics");
    expect(getAppRouteView("/crime-scene")).toBe("crime-scene");
    expect(getAppRouteView("/milestones")).toBe("milestones");
    expect(getAppRouteView("/swimlane")).toBe("swimlane");
    expect(getAppRouteView("/plugin-views")).toBe("plugin-views");
    // Extracted to the board-whimsy plugin (#237) — no longer app routes.
    expect(getAppRouteView("/fireworks")).toBeNull();
    expect(getAppRouteView("/garden")).toBeNull();
    expect(getAppRouteView("/constellation")).toBeNull();
    expect(getAppRouteView("/momentum")).toBeNull();
  });

  it("supports friendly aliases for workspace-oriented links", () => {
    expect(getAppRouteView("/workspaces")).toBe("agents");
    expect(getAppRouteView("/merge-queue")).toBe("agents");
  });

  it("redirects legacy absorbed-chart routes to the Analytics view with the right tab (#234)", () => {
    expect(getAppRouteView("/throughput")).toBe("analytics");
    expect(getAppRouteView("/burndown")).toBe("analytics");
    expect(getAppRouteView("/provider-cost")).toBe("analytics");
    expect(getAppRouteTab("/throughput")).toEqual({ view: "analytics", tab: "throughput" });
    expect(getAppRouteTab("/lead-time")).toEqual({ view: "analytics", tab: "lead-time" });
    expect(getAppRouteTab("/burndown")).toEqual({ view: "analytics", tab: "burndown" });
    expect(getAppRouteTab("/provider-mix")).toEqual({ view: "analytics", tab: "provider-mix" });
    expect(getAppRouteTab("/provider-cost")).toEqual({ view: "analytics", tab: "provider-cost" });
    expect(getAppRouteTab("/agent-throughput")).toEqual({ view: "analytics", tab: "agent-throughput" });
    expect(getAppRouteTab("/scorecard-distribution")).toEqual({ view: "analytics", tab: "scorecard-distribution" });
    // Non-legacy routes carry no tab.
    expect(getAppRouteTab("/analytics")).toBeNull();
    expect(getAppRouteTab("/board")).toBeNull();
  });

  it("redirects legacy event-feed routes to the two surviving feeds with the right tab (#235)", () => {
    expect(getAppRouteView("/digest")).toBe("activity");
    expect(getAppRouteView("/cross-repo-activity")).toBe("activity");
    expect(getAppRouteView("/monitor-history")).toBe("runtime");
    expect(getAppRouteView("/health-events")).toBe("runtime");
    expect(getAppRouteView("/agent-flight-recorder")).toBe("runtime");
    expect(getAppRouteTab("/digest")).toEqual({ view: "activity", tab: "digest" });
    expect(getAppRouteTab("/cross-repo-activity")).toEqual({ view: "activity", tab: "cross-repo" });
    expect(getAppRouteTab("/monitor-history")).toEqual({ view: "runtime", tab: "monitor-cycles" });
    expect(getAppRouteTab("/health-events")).toEqual({ view: "runtime", tab: "health-events" });
    expect(getAppRouteTab("/agent-flight-recorder")).toEqual({ view: "runtime", tab: "flight-recorder" });
    expect(getAppRouteTab("/activity")).toBeNull();
    expect(getAppRouteTab("/runtime")).toBeNull();
  });

  it("ignores unknown non-app paths", () => {
    expect(getAppRouteView("/api/projects")).toBeNull();
    expect(getAppRouteView("/not-a-view")).toBeNull();
  });
});

describe("parseAppPath — legacy flat paths (#446)", () => {
  it("keeps every legacy flat path resolving as today, with no project slug", () => {
    expect(parseAppPath("/")).toEqual({
      projectSlug: null,
      view: "kanban",
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/board")).toEqual({
      projectSlug: null,
      view: "kanban",
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/plugin-views").view).toBe("plugin-views");
    expect(parseAppPath("/merge-queue").view).toBe("agents");
    expect(parseAppPath("/quality-metrics?project=abc").view).toBe("quality-metrics");
    expect(parseAppPath("/board/")).toEqual(parseAppPath("/board"));
  });

  it("carries the legacy absorbed-view tab", () => {
    expect(parseAppPath("/burndown")).toEqual({
      projectSlug: null,
      view: "analytics",
      tab: "burndown",
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/monitor-history")).toEqual({
      projectSlug: null,
      view: "runtime",
      tab: "monitor-cycles",
      issueNumber: null,
      panel: null,
    });
    // A container view with no tab segment resolves to its default (#446) —
    // never null, so the canonical URL can always name a tab.
    expect(parseAppPath("/analytics").tab).toBe("throughput");
    expect(parseAppPath("/board").tab).toBeNull();
  });

  it("agrees with the legacy helpers for every view route", () => {
    for (const view of VIEW_IDS) {
      const path = getViewRoutePath(view);
      expect(parseAppPath(path).view).toBe(getAppRouteView(path));
      const legacyTab = getAppRouteTab(path)?.tab ?? null;
      // Container views resolve to a tab even when the path names none; plain
      // views never do.
      expect(parseAppPath(path).tab).toBe(legacyTab ?? getDefaultViewTab(view));
    }
  });

  it("parses flat issue deep links", () => {
    expect(parseAppPath("/issues/42")).toEqual({
      projectSlug: null,
      view: "kanban",
      tab: null,
      issueNumber: 42,
      panel: "issue",
    });
    expect(parseAppPath("/table/issue/7")).toEqual({
      projectSlug: null,
      view: "table",
      tab: null,
      issueNumber: 7,
      panel: "issue",
    });
  });

  it("returns nulls for non-app paths", () => {
    expect(parseAppPath("/api/projects")).toEqual({
      projectSlug: null,
      view: null,
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/not-a-view").view).toBeNull();
    expect(parseAppPath("").view).toBe("kanban");
  });
});

describe("parseAppPath — project-scoped paths (#446)", () => {
  it("defaults to the kanban view", () => {
    expect(parseAppPath("/p/mealplan")).toEqual({
      projectSlug: "mealplan",
      view: "kanban",
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/p/mealplan/")).toEqual(parseAppPath("/p/mealplan"));
  });

  it("parses a project-scoped view", () => {
    expect(parseAppPath("/p/mealplan/plugin-views")).toEqual({
      projectSlug: "mealplan",
      view: "plugin-views",
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/p/agentic-kanban/board").view).toBe("kanban");
    expect(parseAppPath("/p/agentic-kanban/merge-queue").view).toBe("agents");
  });

  it("supports a raw project id in place of the slug", () => {
    const parsed = parseAppPath("/p/d1c5d9c1-4897-4e1b-acc3-2aa96de04117/board");
    expect(parsed.projectSlug).toBe("d1c5d9c1-4897-4e1b-acc3-2aa96de04117");
    expect(parsed.view).toBe("kanban");
  });

  it("supports a legacy tab route nested under a project", () => {
    expect(parseAppPath("/p/mealplan/burndown")).toEqual({
      projectSlug: "mealplan",
      view: "analytics",
      tab: "burndown",
      issueNumber: null,
      panel: null,
    });
  });

  it("parses the issue deep link on any view", () => {
    expect(parseAppPath("/p/mealplan/board/issue/446")).toEqual({
      projectSlug: "mealplan",
      view: "kanban",
      tab: null,
      issueNumber: 446,
      panel: "issue",
    });
    expect(parseAppPath("/p/mealplan/burndown/issue/9")).toEqual({
      projectSlug: "mealplan",
      view: "analytics",
      tab: "burndown",
      issueNumber: 9,
      panel: "issue",
    });
  });

  it("accepts the /issues/<n> short alias as kanban + issue", () => {
    expect(parseAppPath("/p/mealplan/issues/12")).toEqual({
      projectSlug: "mealplan",
      view: "kanban",
      tab: null,
      issueNumber: 12,
      panel: "issue",
    });
  });

  it("decodes a percent-encoded slug segment", () => {
    expect(parseAppPath("/p/meal%20plan/board").projectSlug).toBe("meal plan");
  });

  it("rejects garbage gracefully, without throwing", () => {
    expect(parseAppPath("/p")).toEqual({
      projectSlug: null,
      view: null,
      tab: null,
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/p/")).toEqual({
      projectSlug: null,
      view: null,
      tab: null,
      issueNumber: null,
      panel: null,
    });
    // Unknown view segment — project is still known, view is not.
    expect(parseAppPath("/p/mealplan/not-a-view")).toEqual({
      projectSlug: "mealplan",
      view: null,
      tab: null,
      issueNumber: null,
      panel: null,
    });
    // Non-numeric / invalid issue numbers.
    expect(parseAppPath("/p/mealplan/board/issue/abc").view).toBeNull();
    expect(parseAppPath("/p/mealplan/board/issue/0").view).toBeNull();
    expect(parseAppPath("/p/mealplan/board/issue/-3").view).toBeNull();
    expect(parseAppPath("/p/mealplan/issues/abc").view).toBeNull();
    expect(parseAppPath("/p/mealplan/issues").view).toBeNull();
    // Junk trailing segments.
    expect(parseAppPath("/p/mealplan/board/issue/7/extra").view).toBeNull();
    expect(parseAppPath("/p/mealplan/board/nonsense").view).toBeNull();
    expect(() => parseAppPath("/p/%E0%A4%A/board")).not.toThrow();
  });
});

describe("buildAppPath (#446)", () => {
  it("returns today's flat path when there is no project slug", () => {
    for (const view of VIEW_IDS) {
      expect(buildAppPath({ view })).toBe(getViewRoutePath(view));
      expect(buildAppPath({ projectSlug: null, view })).toBe(getViewRoutePath(view));
    }
  });

  it("returns a project-scoped path when given a slug", () => {
    expect(buildAppPath({ projectSlug: "mealplan", view: "kanban" })).toBe("/p/mealplan/board");
    expect(buildAppPath({ projectSlug: "mealplan", view: "plugin-views" })).toBe(
      "/p/mealplan/plugin-views",
    );
    expect(buildAppPath({ projectSlug: "mealplan", view: "kanban", issueNumber: 446 })).toBe(
      "/p/mealplan/board/issue/446",
    );
  });

  it("never emits the /issues/<n> inbound alias", () => {
    for (const view of VIEW_IDS) {
      expect(buildAppPath({ projectSlug: "x", view, issueNumber: 7 })).not.toContain("/issues/");
    }
  });

  it("ignores an invalid issue number", () => {
    expect(buildAppPath({ projectSlug: "x", view: "kanban", issueNumber: 0 })).toBe("/p/x/board");
    expect(buildAppPath({ projectSlug: "x", view: "kanban", issueNumber: null })).toBe("/p/x/board");
    expect(buildAppPath({ view: "kanban", issueNumber: -2 })).toBe("/board");
  });

  it("round-trips every view through parseAppPath", () => {
    for (const view of VIEW_IDS) {
      const path = buildAppPath({ projectSlug: "x", view, issueNumber: 7 });
      expect(parseAppPath(path)).toMatchObject({
        projectSlug: "x",
        view,
        issueNumber: 7,
        panel: "issue",
      });
      const noIssue = buildAppPath({ projectSlug: "x", view });
      expect(parseAppPath(noIssue)).toMatchObject({
        projectSlug: "x",
        view,
        issueNumber: null,
        panel: null,
      });
      // Flat form round-trips too.
      expect(parseAppPath(buildAppPath({ view }))).toMatchObject({
        projectSlug: null,
        view,
      });
    }
  });
});

/**
 * The workspace/diff drawer is a SECOND issue-bearing panel. MEASURED: opening
 * it from the "Recently merged" strip left the URL on `/p/eventhub/board` — the
 * URL claimed nothing was open while a full panel was on screen, and the state
 * could not be reloaded or pasted. A shape that reopened the DETAIL panel on
 * reload would be no fix either, so the segment names WHICH panel.
 */
describe("issue panel segment — /issue/<n>/workspace", () => {
  it("parses the workspace panel, scoped and flat", () => {
    expect(parseAppPath("/p/eventhub/board/issue/28/workspace")).toEqual({
      projectSlug: "eventhub",
      view: "kanban",
      tab: null,
      issueNumber: 28,
      panel: "workspace",
    });
    expect(parseAppPath("/table/issue/7/workspace")).toEqual({
      projectSlug: null,
      view: "table",
      tab: null,
      issueNumber: 7,
      panel: "workspace",
    });
  });

  it("treats a bare /issue/<n> as the detail panel", () => {
    expect(parseAppPath("/p/eventhub/board/issue/28").panel).toBe("issue");
    expect(parseAppPath("/issues/28").panel).toBe("issue");
    expect(parseAppPath("/p/eventhub/board").panel).toBeNull();
  });

  it("rejects an unknown panel segment rather than guessing a panel", () => {
    expect(parseAppPath("/p/eventhub/board/issue/28/nonsense").view).toBeNull();
    expect(parseAppPath("/p/eventhub/board/issue/28/workspace/extra").view).toBeNull();
    expect(parseAppPath("/table/issue/7/nonsense").view).toBeNull();
  });

  it("builds the workspace form and round-trips it", () => {
    expect(
      buildAppPath({ projectSlug: "eventhub", view: "kanban", issueNumber: 28, panel: "workspace" }),
    ).toBe("/p/eventhub/board/issue/28/workspace");
    // No issue = no panel segment, whatever the panel says.
    expect(buildAppPath({ projectSlug: "x", view: "kanban", panel: "workspace" })).toBe("/p/x/board");
    for (const panel of ["issue", "workspace"] as const) {
      const path = buildAppPath({ projectSlug: "x", view: "graph", issueNumber: 9, panel });
      expect(parseAppPath(path)).toMatchObject({ view: "graph", issueNumber: 9, panel });
    }
  });
});

/**
 * MEASURED: `/p/taskflow/burndown` rendered the Burndown tab but the URL was
 * canonicalised to `/p/taskflow/analytics` — the shared link no longer selected
 * Burndown, and switching tabs never changed the URL at all. Several views
 * absorbed whole former views as tabs (#234/#235), so most of the app was
 * unlinkable. The tab is now a real segment (#446).
 */
describe("tab segment — /p/<slug>/<view>/<tab>", () => {
  it("parses an explicit tab, scoped and flat", () => {
    expect(parseAppPath("/p/taskflow/analytics/burndown")).toEqual({
      projectSlug: "taskflow",
      view: "analytics",
      tab: "burndown",
      issueNumber: null,
      panel: null,
    });
    expect(parseAppPath("/runtime/health-events")).toEqual({
      projectSlug: null,
      view: "runtime",
      tab: "health-events",
      issueNumber: null,
      panel: null,
    });
  });

  it("falls back to the view's default tab for an unknown tab segment", () => {
    expect(parseAppPath("/p/taskflow/analytics/nonsense")).toMatchObject({
      projectSlug: "taskflow",
      view: "analytics",
      tab: "throughput",
    });
    expect(parseAppPath("/activity/nonsense").tab).toBe("activity");
  });

  it("never invents a tab for a plain view", () => {
    expect(parseAppPath("/p/taskflow/board").tab).toBeNull();
    // …and an extra segment on a plain view is junk, not a tab.
    expect(parseAppPath("/p/taskflow/board/nonsense").view).toBeNull();
    expect(parseAppPath("/table/nonsense").view).toBeNull();
  });

  it("keeps the issue deep link working alongside a tab", () => {
    expect(parseAppPath("/p/taskflow/analytics/burndown/issue/12")).toEqual({
      projectSlug: "taskflow",
      view: "analytics",
      tab: "burndown",
      issueNumber: 12,
      panel: "issue",
    });
    expect(parseAppPath("/p/taskflow/runtime/monitor-cycles/issue/12/workspace")).toMatchObject({
      view: "runtime",
      tab: "monitor-cycles",
      issueNumber: 12,
      panel: "workspace",
    });
    // No tab segment: the issue link still parses, tab is the default.
    expect(parseAppPath("/p/taskflow/analytics/issue/12")).toMatchObject({
      view: "analytics",
      tab: "throughput",
      issueNumber: 12,
      panel: "issue",
    });
  });

  it("does not let a tab segment be confused with the reserved segments", () => {
    for (const view of Object.keys(VIEW_TAB_REGISTRY)) {
      for (const tab of getViewTabIds(view)) {
        expect(RESERVED_ROUTE_SEGMENTS).not.toContain(tab);
      }
    }
    // A reserved word in the tab position is not a tab — it must still parse as
    // (or fail as) the issue grammar.
    expect(parseAppPath("/p/taskflow/analytics/issues/12").view).toBeNull();
    expect(parseAppPath("/p/taskflow/analytics/workspace").tab).toBe("throughput");
  });

  it("builds and round-trips the tab-bearing form", () => {
    expect(buildAppPath({ projectSlug: "taskflow", view: "analytics", tab: "burndown" })).toBe(
      "/p/taskflow/analytics/burndown",
    );
    expect(buildAppPath({ view: "activity", tab: "digest" })).toBe("/activity/digest");
    // Unknown tab -> the default, never junk in the address bar.
    expect(buildAppPath({ projectSlug: "x", view: "analytics", tab: "nope" })).toBe(
      "/p/x/analytics/throughput",
    );
    // Plain views never grow a segment, whatever the tab says.
    expect(buildAppPath({ projectSlug: "x", view: "kanban", tab: "burndown" })).toBe("/p/x/board");
    // Omitted tab stays omitted (the sync layer supplies the resolved tab).
    expect(buildAppPath({ projectSlug: "x", view: "analytics" })).toBe("/p/x/analytics");

    for (const view of Object.keys(VIEW_TAB_REGISTRY)) {
      for (const tab of getViewTabIds(view)) {
        const path = buildAppPath({ projectSlug: "x", view: view as ViewMode, tab });
        expect(parseAppPath(path)).toMatchObject({ projectSlug: "x", view, tab });
        const withIssue = buildAppPath({ projectSlug: "x", view: view as ViewMode, tab, issueNumber: 3, panel: "workspace" });
        expect(parseAppPath(withIssue)).toMatchObject({ view, tab, issueNumber: 3, panel: "workspace" });
      }
    }
  });

  it("every registered container view has a routable default tab", () => {
    for (const view of Object.keys(VIEW_TAB_REGISTRY)) {
      const def = getDefaultViewTab(view);
      expect(getViewTabIds(view)).toContain(def);
      expect(RESERVED_ROUTE_SEGMENTS).not.toContain(def);
      // The registry keys ARE view modes — otherwise no URL could reach them.
      expect(VIEW_IDS).toContain(view);
    }
  });
});
