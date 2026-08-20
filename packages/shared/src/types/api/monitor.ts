/**
 * `GET /api/internal/monitor-status` — the wire contract, declared once (#567).
 *
 * The route built an untyped object literal and the client re-declared its whole shape
 * by hand in `client/src/lib/monitor-popover.ts` (~90 lines): `MonitorTunables`,
 * `StartMode`, `StartPolicy`, `ResolvedTunables`, `ConductorSchedule`, the two warning
 * shapes, `MonitorAction`, `MonitorStatus`. Being a hand mirror, it had drifted —
 * `refillFocus` widened to `string`, `StartPolicy` lost `postMergeFollowups`, and
 * `currentCycle` / `maintenanceActive` / `maintenanceEnd` were simply absent, so a
 * client reading them got `any` with no warning.
 *
 * Types only — the one runtime helper (`isAutodriveStallWarning`) stays with its
 * consumer, since `types/` is an `export type *` barrel and cannot carry values.
 */
import type { MonitorActionName } from "../../lib/monitor-action.js";
import type { MonitorTunables } from "../../lib/strategy-objective-file.js";

// Re-exported so consumers take it from the wire-contract barrel. The client used to
// deep-import lib/strategy-objective-file for it, which drags a Node-builtin chain into
// the client-safety guard's reachability graph even for a type-only import (#596).
export type { MonitorTunables };
import type { START_MODE_VALUES } from "../../lib/dynamic-preference-keys.js";

export type StartMode = (typeof START_MODE_VALUES)[number];

/** Which auto-start paths a project's Start Mode permits. See decision 008. */
export interface StartPolicy {
  mode: StartMode;
  /** The in-process monitor may auto-start unblocked backlog/todo tickets. */
  autoStartUnblocked: boolean;
  /** The post-merge dependency cascade may start the next unblocked ticket. */
  postMergeCascade: boolean;
  /** The post-merge FOLLOW-UP auto-start may run — a second, independent starter. */
  postMergeFollowups: boolean;
  /** The backlog-empty refill skill may run to generate tickets. */
  backlogRefill: boolean;
  /** Cron/HTTP scheduled runs are honored. */
  scheduledRuns: boolean;
  /** Effective WIP/refill tunables (from the Strategy Bullseye, else legacy prefs). */
  wip: MonitorTunables;
  /** Whether the mode came from an explicit per-project `start_mode_<id>` or was derived. */
  source: "start_mode" | "derived";
}

/** `GET /api/board-monitor/tunables` — the resolved WIP/refill numbers and where they came from. */
export interface ResolvedTunablesResponse {
  tunables: MonitorTunables;
  source: "strategy" | "prefs";
  startPolicy?: StartPolicy;
}

export interface ConductorSchedule {
  enabled: boolean;
  cron: string;
  agent: "claude" | "codex";
  lastFiredAt: string | null;
  valid: boolean;
  error: string | null;
  description: string | null;
  nextFireAt: string | null;
}

/**
 * The main checkout has uncommitted tracked source changes, which blocks every merge.
 *
 * `type` is NEW (#567): this warning had no discriminant, so the client narrowed the
 * union with `"type" in warning` — a structural test that silently stops working the
 * day a second undiscriminated member is added.
 */
export interface DirtyMainCheckoutWarning {
  type: "dirty_main_checkout";
  projectId: string;
  projectName: string;
  repoPath: string;
  detectedAt: string;
  fileCount: number;
  files: string[];
  message: string;
}

export interface AutodriveStallWarning {
  type: "autodrive_stall";
  projectId: string;
  projectName: string;
  detectedAt: string;
  thresholdMin: number;
  stalledForMin: number;
  lastProgressAt: string;
  activeIssueCount: number;
  workspaceIds: string[];
  issueNumbers: number[];
  cause: string;
  message: string;
}

/**
 * A project's base-branch health probe has a DEGENERATE verdict distribution: many probes, not
 * one green, ever (#681).
 *
 * The gate reads only the latest verdict, where "red again" and "the probe itself is broken"
 * look identical. Measured on the dev board: 200 probes, 199 red + 1 timeout, 0 green over five
 * days, with reds that were unmistakable install artifacts — roughly half of all recorded
 * base-health verdicts were false, and no mechanism said a word. This warning is the mechanism.
 */
export interface DegenerateBaseHealthWarning {
  type: "degenerate_base_health";
  projectId: string;
  projectName: string;
  detectedAt: string;
  /** Probes recorded for this project, ever. */
  probeCount: number;
  greenCount: number;
  redCount: number;
  timeoutCount: number;
  /** ISO timestamps bounding the degenerate window, so the message can name how long it ran. */
  firstProbeAt: string | null;
  lastProbeAt: string | null;
  message: string;
}

export type MonitorWarning = DirtyMainCheckoutWarning | AutodriveStallWarning | DegenerateBaseHealthWarning;

export interface MonitorAction {
  at: string;
  action: MonitorActionName;
  workspaceId: string;
  issueId: string;
  /** HTTP endpoint called for this action, e.g. /api/workspaces/:id/merge */
  endpoint?: string;
  /** HTTP response status code */
  httpStatus?: number;
  /** Truncated response body summary */
  responseSummary?: string;
  /** Post-action verification result */
  verificationResult?: "ok" | "failed" | "skipped";
}

export interface MonitorResourceSummary {
  processCount: number;
  listenerCount: number;
  activeWorkspaceCount: number;
  keptCount: number;
  cleanedCount: number;
  cleanupFailedCount: number;
}

export interface MonitorLastRun {
  at: string;
  relaunched: number;
  merged: number;
  nudged: number;
  resources: MonitorResourceSummary | null;
  warnings: number;
  deferredProjectIds?: string[];
  skippedProjectIds?: string[];
  notStartedProjectIds?: string[];
}

/** One process-tree decision from the resource sweep, as the status endpoint reports it. */
export interface MonitorResourceDecision {
  rootPid: number;
  pids: number[];
  listenerPorts: number[];
  associatedWorkspaceIds: string[];
  action?: "kept" | "cleaned" | "cleanup_failed";
  reason: string;
}

export interface MonitorStatusResponse {
  /**
   * #357 — "will work start on its own?". The global toggle OR any monitor-mode project,
   * NOT the raw `auto_monitor` pref: reporting the raw pref made the board say "monitor
   * off" while cycles were running. The raw toggle is `globalToggle`.
   */
  enabled: boolean;
  globalToggle: boolean;
  monitorDrivenProjectCount: number;
  intervalMin: number;
  /** A timer is armed for a FUTURE cycle. Not the same as "a cycle is running". */
  active: boolean;
  /** A cycle is executing right now. `nextRunAt` is null while this is true. */
  cycleInFlight: boolean;
  lastRun: MonitorLastRun | null;
  /** Progress marker for the cycle IN FLIGHT (null when none is running) — #208. */
  currentCycle: { startedAt: string; phase: string } | null;
  nextRunAt: string | null;
  recentActions: MonitorAction[];
  resourceSnapshot: {
    at: string;
    kept: MonitorResourceDecision[];
    cleaned: MonitorResourceDecision[];
  } | null;
  warnings: MonitorWarning[];
  lastHealthCheckAt: string | null;
  /** Verbose-only: per-phase durations of the last completed cycle (#347). */
  lastCyclePhaseTimings?: unknown;
  maintenanceActive: boolean;
  maintenanceEnd: string | null;
}
