import { describe, expect, it } from "vitest";
import {
  buildAppPath,
  getAppRouteTab,
  getAppRouteView,
  getViewRoutePath,
  parseAppPath,
} from "./appRoutes";
import { VIEW_IDS } from "./viewRegistry";

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
    });
    expect(parseAppPath("/board")).toEqual({
      projectSlug: null,
      view: "kanban",
      tab: null,
      issueNumber: null,
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
    });
    expect(parseAppPath("/monitor-history")).toEqual({
      projectSlug: null,
      view: "runtime",
      tab: "monitor-cycles",
      issueNumber: null,
    });
    expect(parseAppPath("/analytics").tab).toBeNull();
  });

  it("agrees with the legacy helpers for every view route", () => {
    for (const view of VIEW_IDS) {
      const path = getViewRoutePath(view);
      expect(parseAppPath(path).view).toBe(getAppRouteView(path));
      expect(parseAppPath(path).tab).toBe(getAppRouteTab(path)?.tab ?? null);
    }
  });

  it("parses flat issue deep links", () => {
    expect(parseAppPath("/issues/42")).toEqual({
      projectSlug: null,
      view: "kanban",
      tab: null,
      issueNumber: 42,
    });
    expect(parseAppPath("/table/issue/7")).toEqual({
      projectSlug: null,
      view: "table",
      tab: null,
      issueNumber: 7,
    });
  });

  it("returns nulls for non-app paths", () => {
    expect(parseAppPath("/api/projects")).toEqual({
      projectSlug: null,
      view: null,
      tab: null,
      issueNumber: null,
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
    });
    expect(parseAppPath("/p/mealplan/")).toEqual(parseAppPath("/p/mealplan"));
  });

  it("parses a project-scoped view", () => {
    expect(parseAppPath("/p/mealplan/plugin-views")).toEqual({
      projectSlug: "mealplan",
      view: "plugin-views",
      tab: null,
      issueNumber: null,
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
    });
  });

  it("parses the issue deep link on any view", () => {
    expect(parseAppPath("/p/mealplan/board/issue/446")).toEqual({
      projectSlug: "mealplan",
      view: "kanban",
      tab: null,
      issueNumber: 446,
    });
    expect(parseAppPath("/p/mealplan/burndown/issue/9")).toEqual({
      projectSlug: "mealplan",
      view: "analytics",
      tab: "burndown",
      issueNumber: 9,
    });
  });

  it("accepts the /issues/<n> short alias as kanban + issue", () => {
    expect(parseAppPath("/p/mealplan/issues/12")).toEqual({
      projectSlug: "mealplan",
      view: "kanban",
      tab: null,
      issueNumber: 12,
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
    });
    expect(parseAppPath("/p/")).toEqual({
      projectSlug: null,
      view: null,
      tab: null,
      issueNumber: null,
    });
    // Unknown view segment — project is still known, view is not.
    expect(parseAppPath("/p/mealplan/not-a-view")).toEqual({
      projectSlug: "mealplan",
      view: null,
      tab: null,
      issueNumber: null,
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
      });
      const noIssue = buildAppPath({ projectSlug: "x", view });
      expect(parseAppPath(noIssue)).toMatchObject({
        projectSlug: "x",
        view,
        issueNumber: null,
      });
      // Flat form round-trips too.
      expect(parseAppPath(buildAppPath({ view }))).toMatchObject({
        projectSlug: null,
        view,
      });
    }
  });
});
