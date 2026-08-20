import { describe, expect, it } from "vitest";
import type { ServiceStackState } from "@agentic-kanban/shared";
import {
  buildFleetServiceStacks,
  fleetStackState,
  type FleetStackInput,
} from "./fleetServiceStacks.js";

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

function input(partial: Partial<FleetStackInput> = {}): FleetStackInput {
  return {
    workspaceId: "ws-1",
    issueNumber: 1,
    issueTitle: "Issue 1",
    branch: "feature/ak-1",
    serviceState: stack(),
    ...partial,
  };
}

describe("fleetStackState", () => {
  it("maps stack status + deferred to the fleet-normalised state", () => {
    expect(fleetStackState(stack({ status: "up" }))).toBe("running");
    expect(fleetStackState(stack({ status: "down" }))).toBe("stopped");
    expect(fleetStackState(stack({ status: "error" }))).toBe("error");
    expect(fleetStackState(stack({ status: "error", deferred: true }))).toBe("deferred");
  });
});

describe("buildFleetServiceStacks", () => {
  it("returns an empty map + zeroed summary for no inputs (empty state)", () => {
    const result = buildFleetServiceStacks([]);
    expect(result.groups).toEqual([]);
    expect(result.summary).toEqual({
      stackCount: 0,
      runningContainers: 0,
      allocatedPorts: 0,
      unhealthy: 0,
    });
  });

  it("drops workspaces that have no stack (serviceState null)", () => {
    const result = buildFleetServiceStacks([
      input({ workspaceId: "a", serviceState: null }),
      input({ workspaceId: "b", serviceState: null }),
    ]);
    expect(result.groups).toEqual([]);
    expect(result.summary.stackCount).toBe(0);
  });

  it("groups by workspace with a service row per named port", () => {
    const result = buildFleetServiceStacks([
      input({
        workspaceId: "ws-7",
        issueNumber: 7,
        serviceState: stack({
          composeProjectName: "kanban-ws-7-stack",
          ports: { redis: 54322, db: 54321 },
          status: "up",
        }),
      }),
    ]);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.workspaceId).toBe("ws-7");
    expect(group.composeProjectName).toBe("kanban-ws-7-stack");
    // Services are sorted by name (db before redis).
    expect(group.services).toEqual([
      { name: "db", hostPort: 54321, state: "running" },
      { name: "redis", hostPort: 54322, state: "running" },
    ]);
  });

  it("aggregates a correct summary across 2+ workspaces", () => {
    const result = buildFleetServiceStacks([
      input({
        workspaceId: "ws-1",
        issueNumber: 1,
        serviceState: stack({ ports: { db: 5001, redis: 5002 }, status: "up" }),
      }),
      input({
        workspaceId: "ws-2",
        issueNumber: 2,
        serviceState: stack({ ports: { db: 5003 }, status: "up" }),
      }),
      input({
        workspaceId: "ws-3",
        issueNumber: 3,
        serviceState: stack({ ports: { db: 5004 }, status: "error", error: "boom" }),
      }),
    ]);
    expect(result.summary).toEqual({
      stackCount: 3,
      runningContainers: 3, // ws-1 (2) + ws-2 (1)
      allocatedPorts: 4, // 2 + 1 + 1
      unhealthy: 1, // ws-3's one service
    });
  });

  it("does not count a capacity-deferred stack as unhealthy", () => {
    const result = buildFleetServiceStacks([
      input({
        workspaceId: "ws-1",
        serviceState: stack({ ports: {}, status: "error", deferred: true }),
      }),
    ]);
    expect(result.groups[0].state).toBe("deferred");
    expect(result.summary.unhealthy).toBe(0);
    expect(result.summary.runningContainers).toBe(0);
  });

  it("synthesises a single portless row so an up stack is never invisible", () => {
    const result = buildFleetServiceStacks([
      input({ workspaceId: "ws-1", serviceState: stack({ ports: {}, status: "up" }) }),
    ]);
    expect(result.groups[0].services).toEqual([
      { name: "stack", hostPort: null, state: "running" },
    ]);
    // The synthetic row counts as a running container but not an allocated port.
    expect(result.summary.runningContainers).toBe(1);
    expect(result.summary.allocatedPorts).toBe(0);
  });

  it("carries the repo label and sorts groups by issue number (nulls last)", () => {
    const result = buildFleetServiceStacks([
      input({ workspaceId: "c", issueNumber: null, branch: "feature/z" }),
      input({ workspaceId: "a", issueNumber: 5, repoName: "api", branch: "feature/a" }),
      input({ workspaceId: "b", issueNumber: 2, repoName: null, branch: "feature/b" }),
    ]);
    expect(result.groups.map((g) => g.workspaceId)).toEqual(["b", "a", "c"]);
    expect(result.groups[1].repoName).toBe("api");
    expect(result.groups[2].issueNumber).toBeNull();
  });
});
