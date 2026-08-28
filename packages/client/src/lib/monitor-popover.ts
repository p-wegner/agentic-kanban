/**
 * Client-side labels and parsing for the monitor popover.
 *
 * Every wire type this file used to re-declare by hand now comes from shared (#567).
 * The mirror had drifted: `refillFocus` had widened to `string`, `StartPolicy` was
 * missing `postMergeFollowups`, and `currentCycle` / `maintenanceActive` /
 * `maintenanceEnd` were absent from `MonitorStatus` entirely.
 */
import type { MonitorWarning, AutodriveStallWarning, StartMode } from "@agentic-kanban/shared";

export type {
  MonitorTunables,
  StartMode,
  StartPolicy,
  ResolvedTunablesResponse as ResolvedTunables,
  ConductorSchedule,
  DirtyMainCheckoutWarning,
  AutodriveStallWarning,
  MonitorWarning,
  MonitorAction,
  MonitorStatusResponse as MonitorStatus,
} from "@agentic-kanban/shared";
export type { BoardHealthEventDto as BoardHealthEvent } from "@agentic-kanban/shared";

/** Narrow the warning union. Both members carry a `type` discriminant since #567. */
export function isAutodriveStallWarning(warning: MonitorWarning): warning is AutodriveStallWarning {
  return warning.type === "autodrive_stall";
}

export const START_MODE_LABEL: Record<StartMode, string> = { manual: "Manual", monitor: "Monitor", conductor: "Conductor" };
export const START_MODE_HINT: Record<StartMode, string> = {
  manual: "Nothing auto-starts. Only you / agents start workspaces explicitly.",
  monitor: "The in-process monitor auto-starts unblocked backlog tickets up to the WIP target.",
  conductor: "The out-of-process board-monitor loop is the sole driver; the in-process monitor stands down.",
};



/** One ranked row from `GET /api/projects/:id/board-monitor/next` (#917). */
export interface NextStartCandidate {
  id: string;
  issueNumber: number | null;
  title: string;
  score: {
    score: number;
    priority: string;
    priorityWeight: number;
    unblockCount: number;
    ageHours: number;
    ageFactor: number;
    predictedCost: number;
    bullseyeMultiplier: number;
    bullseyeSegmentId: string | null;
  };
}

export function parseCycleLine(line: string): { age: string | null; text: string } {
  // Format: "<ISO time> | <action> | <items>". Be lenient.
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length >= 2) {
    const ts = new Date(parts[0]);
    const age = Number.isNaN(ts.getTime()) ? null : parts[0];
    return { age, text: parts.slice(1).join(" · ") };
  }
  return { age: null, text: line };
}
