// Pure aggregation for the Fleet Service-Stack Map (#95).
//
// `ServiceStackStatusPanel` shows ONE workspace's Docker service stack. When
// several workspaces each spin up their own stack (postgres+redis+…) there is no
// single view of everything running — the blind spot behind the "N workspaces =
// N postgres" hazard. This module reduces the per-workspace `serviceState`s the
// board already exposes into a fleet-wide map: services grouped by workspace (and
// by the repo the compose file lives in), plus a header summary (running
// containers, allocated host ports, unhealthy/exited count).
//
// The service-stack data model (`ServiceStackState`) is stack-level: one status
// (up/error/down, plus a `deferred` capacity flag) and a `name -> host port` map.
// Each named port is treated as one compose service/container; a stack with no
// named ports still surfaces as a single synthetic "stack" row so an up stack is
// never invisible. This is intentionally a pure function of its inputs so the
// component can fetch live and re-aggregate on every board event.

import type { ServiceStackState } from "@agentic-kanban/shared";

/** One active workspace's stack, as fed into the fleet aggregation. */
export interface FleetStackInput {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string | null;
  branch: string | null;
  /**
   * Repo the compose file lives in (the project-level `composeRepo`); null = the
   * leading repo. Labels the group for multi-repo projects.
   */
  repoName?: string | null;
  /** The per-workspace stack state, or null when the workspace has no stack. */
  serviceState: ServiceStackState | null;
}

/**
 * Fleet-normalised state of a stack (and of each of its services). Derived from
 * `ServiceStackState.status` + `deferred`:
 *   up               → "running"
 *   error (deferred) → "deferred"  (held at the capacity cap, not a failure)
 *   error            → "error"     (unhealthy/exited)
 *   down             → "stopped"
 */
export type FleetServiceState = "running" | "deferred" | "error" | "stopped";

/** One compose service row (a named host port, or the synthetic whole-stack row). */
export interface FleetService {
  name: string;
  /** Allocated host port, or null for the synthetic portless "stack" row. */
  hostPort: number | null;
  state: FleetServiceState;
}

/** All services of one workspace's stack, grouped for the fleet map. */
export interface FleetStackGroup {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string | null;
  branch: string | null;
  /** null = leading repo. */
  repoName: string | null;
  composeProjectName: string;
  state: FleetServiceState;
  services: FleetService[];
}

export interface FleetServiceStackSummary {
  /** Workspaces that have a stack (one stack per workspace). */
  stackCount: number;
  /** Services in a "running" (up) stack. */
  runningContainers: number;
  /** Total allocated host ports across every stack (reserved even while down). */
  allocatedPorts: number;
  /** Services in an "error" (unhealthy/exited) stack. Deferred is NOT counted. */
  unhealthy: number;
}

export interface FleetServiceStackMapData {
  groups: FleetStackGroup[];
  summary: FleetServiceStackSummary;
}

/** Map a stack's status (+ deferred flag) to the fleet-normalised state. */
export function fleetStackState(state: ServiceStackState): FleetServiceState {
  switch (state.status) {
    case "up":
      return "running";
    case "down":
      return "stopped";
    case "error":
      return state.deferred ? "deferred" : "error";
    default:
      return "stopped";
  }
}

/** Sort key: issue number ascending (nulls last), then branch, then workspace id. */
function compareGroups(a: FleetStackGroup, b: FleetStackGroup): number {
  if (a.issueNumber !== b.issueNumber) {
    if (a.issueNumber === null) return 1;
    if (b.issueNumber === null) return -1;
    return a.issueNumber - b.issueNumber;
  }
  const branchCmp = (a.branch ?? "").localeCompare(b.branch ?? "");
  if (branchCmp !== 0) return branchCmp;
  return a.workspaceId.localeCompare(b.workspaceId);
}

/**
 * Aggregate every active workspace's `serviceState` into a fleet-wide map.
 * Inputs without a stack (`serviceState == null`) are dropped. The result is
 * stable-sorted so the panel doesn't reshuffle on each live refresh.
 */
export function buildFleetServiceStacks(inputs: FleetStackInput[]): FleetServiceStackMapData {
  const groups: FleetStackGroup[] = [];

  for (const input of inputs) {
    const state = input.serviceState;
    if (!state) continue;

    const groupState = fleetStackState(state);
    const portEntries = Object.entries(state.ports ?? {});
    const services: FleetService[] =
      portEntries.length > 0
        ? portEntries
            .map(([name, hostPort]) => ({ name, hostPort, state: groupState }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [{ name: "stack", hostPort: null, state: groupState }];

    groups.push({
      workspaceId: input.workspaceId,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      branch: input.branch,
      repoName: input.repoName ?? null,
      composeProjectName: state.composeProjectName,
      state: groupState,
      services,
    });
  }

  groups.sort(compareGroups);

  let runningContainers = 0;
  let allocatedPorts = 0;
  let unhealthy = 0;
  for (const group of groups) {
    for (const service of group.services) {
      if (service.state === "running") runningContainers += 1;
      else if (service.state === "error") unhealthy += 1;
      if (service.hostPort !== null) allocatedPorts += 1;
    }
  }

  return {
    groups,
    summary: {
      stackCount: groups.length,
      runningContainers,
      allocatedPorts,
      unhealthy,
    },
  };
}
