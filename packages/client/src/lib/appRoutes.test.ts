import { describe, expect, it } from "vitest";
import { getAppRouteTab, getAppRouteView, getViewRoutePath } from "./appRoutes";

describe("appRoutes", () => {
  it("maps key view modes to stable frontend paths", () => {
    expect(getViewRoutePath("kanban")).toBe("/board");
    expect(getViewRoutePath("butler")).toBe("/butler");
    expect(getViewRoutePath("workflows")).toBe("/workflows");
    expect(getViewRoutePath("agents")).toBe("/agents");
    expect(getViewRoutePath("crime-scene")).toBe("/crime-scene");
    expect(getViewRoutePath("milestones")).toBe("/milestones");
    expect(getViewRoutePath("fireworks")).toBe("/fireworks");
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
    expect(getAppRouteView("/fireworks")).toBe("fireworks");
    expect(getAppRouteView("/plugin-views")).toBe("plugin-views");
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

  it("ignores unknown non-app paths", () => {
    expect(getAppRouteView("/api/projects")).toBeNull();
    expect(getAppRouteView("/not-a-view")).toBeNull();
  });
});
