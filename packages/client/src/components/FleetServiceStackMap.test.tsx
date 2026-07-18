import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceStackState } from "@agentic-kanban/shared";
import { FleetServiceStackMapView } from "./FleetServiceStackMap.js";
import { buildFleetServiceStacks, type FleetStackInput } from "../lib/fleetServiceStacks.js";

function stack(partial: Partial<ServiceStackState> = {}): ServiceStackState {
  return {
    composeProjectName: "kanban-ws-stack",
    ports: {},
    envFilePath: "/wt/.kanban-services.env",
    status: "up",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...partial,
  };
}

function render(inputs: FleetStackInput[]) {
  return renderToStaticMarkup(
    <FleetServiceStackMapView data={buildFleetServiceStacks(inputs)} loading={false} error={null} />,
  );
}

describe("FleetServiceStackMapView", () => {
  it("renders the empty state with a zeroed summary when no stacks are running", () => {
    const html = render([]);
    expect(html).toContain("fleet-stack-empty");
    expect(html).toContain("No running service stacks");
    // Summary still renders, all zero.
    expect(html).toContain("fleet-stack-summary");
  });

  it("shows a loading placeholder while data is null", () => {
    const html = renderToStaticMarkup(
      <FleetServiceStackMapView data={null} loading={true} error={null} />,
    );
    expect(html).toContain("Loading service stacks…");
  });

  it("groups every container by workspace with its ports and owning repo", () => {
    const html = render([
      {
        workspaceId: "ws-1",
        issueNumber: 1,
        issueTitle: "Add auth",
        branch: "feature/ak-1-auth",
        repoName: "api",
        serviceState: stack({
          composeProjectName: "kanban-ws-1-stack",
          ports: { db: 54321, redis: 54322 },
          status: "up",
        }),
      },
      {
        workspaceId: "ws-2",
        issueNumber: 2,
        issueTitle: "Add billing",
        branch: "feature/ak-2-billing",
        repoName: "api",
        serviceState: stack({
          composeProjectName: "kanban-ws-2-stack",
          ports: { db: 54323 },
          status: "up",
        }),
      },
    ]);

    // Two workspace groups, one compose project name each.
    expect(html).toContain("kanban-ws-1-stack");
    expect(html).toContain("kanban-ws-2-stack");
    // Issue + repo labels.
    expect(html).toContain("#1");
    expect(html).toContain("#2");
    expect(html).toContain("Add auth");
    expect(html).toContain("api");
    // Every container's mapped host port.
    expect(html).toContain(":54321");
    expect(html).toContain(":54322");
    expect(html).toContain(":54323");
  });

  it("renders a correct aggregate summary across workspaces (incl. an unhealthy stack)", () => {
    const html = render([
      {
        workspaceId: "ws-1",
        issueNumber: 1,
        issueTitle: "A",
        branch: "b1",
        serviceState: stack({ ports: { db: 5001, redis: 5002 }, status: "up" }),
      },
      {
        workspaceId: "ws-2",
        issueNumber: 2,
        issueTitle: "B",
        branch: "b2",
        serviceState: stack({ ports: { db: 5003 }, status: "error", error: "boom" }),
      },
      // No stack — dropped from the map + summary.
      { workspaceId: "ws-3", issueNumber: 3, issueTitle: "C", branch: "b3", serviceState: null },
    ]);

    // 2 stacks, 2 running containers (ws-1), 3 allocated ports, 1 unhealthy (ws-2).
    expect(html).toMatch(/data-testid="fleet-stack-count"[^>]*>2</);
    expect(html).toMatch(/data-testid="fleet-running-count"[^>]*>2</);
    expect(html).toMatch(/data-testid="fleet-ports-count"[^>]*>3</);
    expect(html).toMatch(/data-testid="fleet-unhealthy-count"[^>]*>1</);
  });

  it("surfaces an error when no data has loaded yet", () => {
    const html = renderToStaticMarkup(
      <FleetServiceStackMapView data={null} loading={false} error="boom" />,
    );
    expect(html).toContain("boom");
  });
});
