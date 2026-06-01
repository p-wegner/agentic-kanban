import { describe, expect, it } from "vitest";
import { getAppRouteView, getViewRoutePath } from "./appRoutes";

describe("appRoutes", () => {
  it("maps key view modes to stable frontend paths", () => {
    expect(getViewRoutePath("kanban")).toBe("/board");
    expect(getViewRoutePath("butler")).toBe("/butler");
    expect(getViewRoutePath("workflows")).toBe("/workflows");
    expect(getViewRoutePath("agents")).toBe("/agents");
  });

  it("parses direct links for key views", () => {
    expect(getAppRouteView("/")).toBe("kanban");
    expect(getAppRouteView("/board")).toBe("kanban");
    expect(getAppRouteView("/workflows")).toBe("workflows");
    expect(getAppRouteView("/butler")).toBe("butler");
    expect(getAppRouteView("/quality-metrics?project=abc")).toBe("quality-metrics");
  });

  it("supports friendly aliases for workspace-oriented links", () => {
    expect(getAppRouteView("/workspaces")).toBe("agents");
    expect(getAppRouteView("/merge-queue")).toBe("agents");
  });

  it("ignores unknown non-app paths", () => {
    expect(getAppRouteView("/api/projects")).toBeNull();
    expect(getAppRouteView("/not-a-view")).toBeNull();
  });
});
