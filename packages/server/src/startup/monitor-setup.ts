import { issues, preferences, projectStatuses, projects, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { createSessionManager } from "../services/session.manager.js";
import { runAutoStart } from "./monitor-auto-start.js";
import { runAutoContract } from "./monitor-contract.js";
import { runCompoundingSetup } from "./monitor-compounding-setup.js";
import { runBacklogEmptyStrategy } from "./monitor-backlog.js";
import { getRecentAgentExcerpts, logMonitorAction, shouldSkipNudge, type MonitorAction } from "./monitor-helpers.js";
import { processWorkspaceCandidates } from "./monitor-cycle.js";
import { createMonitorWorkspaceActions } from "./monitor-workspace-actions.js";
import { buildMonitorNudgePrompt } from "./review-helpers.js";
import { snapshotAndCleanStaleDevProcesses, type BoardMonitorResourceSnapshot } from "../services/stale-dev-processes.js";
import { healWorkspaceSummaryProjection } from "../services/workspace-summary-projection.service.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";
import { advanceDuePluginLoops } from "../services/plugin-loop-monitor.js";
import { scanDirtyMainCheckouts, type DirtyMainCheckoutWarning } from "../services/dirty-main-checkout.js";
import { scanAutodriveStallWarnings, buildAutoStartSkipWarnings, type AutodriveStallWarning } from "../services/autodrive-stall-warning.service.js";
import { resolveMergeStrategy } from "./merge-strategy.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { conditionalJsonResponse } from "../services/board-etag-cache.service.js";
import { isAutoMergeEnabled } from "@agentic-kanban/shared/lib/auto-merge-pref";
import { createMonitorPhaseRecorder, type MonitorCycleTimings } from "../lib/monitor-phase-timings.js";
import { createSpawnControlProbe } from "../lib/monitor-spawn-control.js";
import { createMonitorProjectScheduler } from "./monitor-project-scheduler.js";
import { shouldStartHealthRefresh } from "./health-refresh-gate.js";
import { getLoopLagMonitor } from "../lib/loop-lag-registry.js";

/**
 * Per-project hands-off mode. A `board_autodrive_<projectId>` preference set to
 * "true" opts that project into autonomous driving (auto-start / relaunch / refill)
 * EVEN WHEN the global `auto_monitor` toggle is off. This is what lets a freshly-
 * registered project be developed hands-off: the monitor engine already iterates all
 * projects, so a durable per-project flag is enough. The flag is a separate pref key,
 * so the boot-time reset of the GLOBAL `auto_monitor` (startup-tasks.ts) never clobbers it.
 */
const AUTODRIVE_KEY_RE = /^board_autodrive_([0-9a-f-]+)$/;
const START_MODE_KEY_RE = /^start_mode_([0-9a-f-]+)$/;
export function autoDriveProjectIds(prefMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of prefMap) {
    const m = AUTODRIVE_KEY_RE.exec(key);
    if (m && value === "true") ids.add(m[1]);
  }
  return ids;
}

/**
 * Project ids whose *resolved* Start Mode is `monitor` — i.e. the in-process deterministic
 * monitor is their driver. This routes through `resolveStartPolicy` (the single source of truth,
 * decision 008) instead of reading `board_autodrive_*` raw, so it honours both an explicit
 * `start_mode_<id>` AND the legacy-flag derivation, fixing two scheduling bugs:
 *   (a) `start_mode=monitor` with autodrive unset & `auto_monitor` off (force-disabled every boot)
 *       — previously never scheduled because the gate was purely `auto_monitor || board_autodrive`.
 *   (b) `start_mode=manual` with a stale `board_autodrive=true` — no longer counts as driven, so
 *       `manual` is a real kill-switch (the old regex would still schedule/act on it).
 * `conductor` is intentionally NOT included: the external loop drives it and the in-process engine
 * stands down. Candidate ids are gathered from both key families so any project that ever set a
 * mode or a legacy flag is considered.
 */
export function monitorDrivenProjectIds(prefMap: Map<string, string>): Set<string> {
  const candidates = new Set<string>();
  for (const key of prefMap.keys()) {
    const sm = START_MODE_KEY_RE.exec(key);
    if (sm) candidates.add(sm[1]);
    const ad = AUTODRIVE_KEY_RE.exec(key);
    if (ad) candidates.add(ad[1]);
  }
  const ids = new Set<string>();
  for (const projectId of candidates) {
    if (resolveStartPolicy(prefMap, projectId).mode === "monitor") ids.add(projectId);
  }
  return ids;
}

/**
 * The monitor cycle should run/reschedule when the global toggle is on OR any project resolves to
 * `monitor` Start Mode. Start Mode (via `resolveStartPolicy`) — NOT the raw `board_autodrive` flag —
 * is now the authoritative scheduling input, so a `monitor` project schedules even with autodrive
 * unset, and a `manual` project with a stale autodrive flag does not.
 */
export function monitorShouldRun(prefMap: Map<string, string>): boolean {
  return getBool(prefMap, "auto_monitor") || monitorDrivenProjectIds(prefMap).size > 0;
}

export interface MonitorState {
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: string | null;
  lastRun: { at: string; relaunched: number; merged: number; nudged: number; resources: MonitorResourceSummary | null; warnings: number; deferredProjectIds?: string[]; skippedProjectIds?: string[]; notStartedProjectIds?: string[] } | null;
  currentIntervalMin: number | null;
  recentActions: MonitorAction[];
  lastResourceSnapshot: BoardMonitorResourceSnapshot | null;
  warnings: MonitorWarning[];
  lastHealthCheckAt: string | null;
  /**
   * Progress marker for the cycle IN FLIGHT (null when no cycle is running). Written as the
   * cycle advances through its phases, not only once at the end in `finally` — so a long or
   * wedged cycle is observable via `GET /api/internal/monitor-status` instead of looking
   * identical to "never ran" (#208; `lastRun` only reflects the last COMPLETED cycle).
   */
  currentCycle: { startedAt: string; phase: string } | null;
  /**
   * Per-phase durations of the last COMPLETED cycle (#347). Stall windows correlated with
   * monitor cycle starts, but from outside the process the culprit phase could not be
   * pinned: `setPhase` knew every transition and threw the timing away. Read this back
   * alongside `/api/metrics/loop-lag` and the slow-request ring buffer to name the blocker.
   */
  lastCyclePhaseTimings: MonitorCycleTimings | null;
}

export type MonitorWarning = DirtyMainCheckoutWarning | AutodriveStallWarning;

/**
 * #349: the health-warning refresh (`scanDirtyMainCheckouts` + `scanAutodriveStallWarnings`)
 * is PURELY DIAGNOSTIC — nothing in the cycle reads its output — yet it measured 203-265s per
 * cycle and was the single slowest phase of a cycle that never stops running (measured 5-8s
 * gaps between cycles, so `auto_monitor_interval` does not pace this board at all). It was
 * therefore blocking the event loop for ~45% of all wall-clock time, permanently, which is the
 * p50-15ms/max-18s "single long synchronous block" signature #322/#347 recorded on EVERY
 * endpoint. It was ALSO being kicked unguarded every 30s from `syncMonitorState`, with no
 * re-entrancy guard, so a scan that takes minutes had several copies of itself in flight.
 *
 * It is now (a) off the monitor cycle's critical path entirely — the cycle neither awaits nor
 * schedules it — and (b) rate-limited to at most one run per this interval with a single-flight
 * guard, so a slow scan can never again pace the board or pile up on itself.
 */
const HEALTH_WARNING_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * #416: fraction of the configured monitor interval a cycle may spend before it stops
 * starting NEW project sub-passes (the carry-over cursor resumes them next cycle). 2/3
 * leaves the remaining third of every interval genuinely idle for interactive traffic —
 * the measured failure mode was cycle duration >= interval at 10 driven projects, which
 * made `cycleInFlight` permanently true and starved the event loop continuously.
 */
const CYCLE_BUDGET_INTERVAL_FRACTION = 2 / 3;

export interface MonitorResourceSummary {
  processCount: number;
  listenerCount: number;
  activeWorkspaceCount: number;
  keptCount: number;
  cleanedCount: number;
  cleanupFailedCount: number;
}

interface MonitorSetupDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  serverPort: number;
  reviewSessionIds: Set<string>;
  /**
   * The workflow-engine fix-and-merge session set, threaded through so the
   * monitor's workspace-actions port can register fix-and-merge sessions exactly
   * as the HTTP route did (preserving isBuilderSession classification on exit).
   */
  fixAndMergeSessionIds: Set<string>;
}

/** Default (non-verbose) monitor-status caps the resource snapshot's decision lists —
 *  the client renders at most 3 of each (`MonitorSections.tsx`). */
const RESOURCE_SNAPSHOT_ITEM_CAP = 5;

export function setupMonitorRoutes(app: Hono, monitorState: MonitorState, runMonitorCycle: (force?: boolean) => Promise<void>, _syncMonitorState: () => Promise<void>, runResourceSweep?: (force?: boolean) => Promise<BoardMonitorResourceSnapshot | null>) {
  app.post("/api/internal/monitor-run", (c) => {
    if (monitorState.timer) clearTimeout(monitorState.timer);
    monitorState.timer = setTimeout(() => {}, 0);
    monitorState.nextRunAt = null;
    runMonitorCycle(true).catch(() => {});
    return c.json({ triggered: true });
  });
  // Force a resource sweep now (reap orphaned worktree dev servers), regardless of
  // whether auto_monitor is enabled. Lets an external orchestrator loop or a user
  // reclaim resources on demand.
  app.post("/api/internal/resource-sweep", async (c) => {
    if (!runResourceSweep) return c.json({ error: "resource sweep unavailable" }, 503);
    const snapshot = await runResourceSweep(true);
    if (!snapshot) return c.json({ cleaned: 0, kept: 0, listeners: 0 });
    return c.json({
      cleaned: snapshot.cleaned.filter((d) => d.action === "cleaned").length,
      cleanupFailed: snapshot.cleaned.filter((d) => d.action === "cleanup_failed").length,
      kept: snapshot.kept.length,
      listeners: snapshot.listeners.length,
    });
  });
  app.get("/api/internal/monitor-status", async (c) => {
    // #402's short-TTL cache instead of a raw full-table scan — this endpoint is
    // polled every 30s by EVERY open tab, so the scans stacked up fast.
    const prefRows = await getAllPreferencesCached(db);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const maintenanceEnabled = getBool(prefMap, "monitor_maintenance_window_enabled");
    const maintenanceEnd = prefMap.get("monitor_maintenance_window_end") || null;
    const maintenanceActive = maintenanceEnabled && (!maintenanceEnd || new Date(maintenanceEnd).getTime() > Date.now());
    // #357 — each field answers ONE honest question.
    //
    // This endpoint used to report `enabled: false` and `active: true` simultaneously, with a
    // populated `currentCycle` and cycles demonstrably running every ~8 minutes — because
    // `enabled` was the raw GLOBAL `auto_monitor` pref while scheduling actually depends on
    // `monitorShouldRun` (global OR any project whose resolved Start Mode is `monitor`). A user
    // read "monitor off" beside an idle-looking board and reasonably concluded they were stranded;
    // the monitor described as "off" was the thing that had just started their ticket.
    //
    // `enabled` now answers the only question the UI is really asking — WILL work start on its own?
    // The raw toggle is still available as `globalToggle` for the settings control that owns it, and
    // the two are no longer conflated.
    const cycleInFlight = monitorState.currentCycle !== null;
    // 2026-08-11 perf audit: the default payload shipped 36-111KB every 30s to every
    // tab while the client (`client/src/lib/monitor-popover.ts`) reads only `{at, kept,
    // cleaned}` off the resource snapshot — and at most 3 items of each — and never reads
    // `lastCyclePhaseTimings` at all (~92% of the bytes unread). The full snapshot
    // (processes/listeners/activeWorkspaces + uncapped decisions) and the phase timings
    // now sit behind `?verbose=1` for the humans/scripts that actually want them.
    const verbose = c.req.query("verbose") === "1";
    const snapshot = monitorState.lastResourceSnapshot;
    const resourceSnapshot = snapshot === null
      ? null
      : verbose
        ? snapshot
        : {
            at: snapshot.at,
            kept: snapshot.kept.slice(0, RESOURCE_SNAPSHOT_ITEM_CAP),
            cleaned: snapshot.cleaned.slice(0, RESOURCE_SNAPSHOT_ITEM_CAP),
          };
    // Computed ONCE (it walks the whole prefMap) — was evaluated twice below.
    const drivenProjectIds = monitorDrivenProjectIds(prefMap);
    const payload = {
      /** Will the monitor run on its own? (global toggle OR a monitor-mode project) */
      enabled: getBool(prefMap, "auto_monitor") || drivenProjectIds.size > 0,
      /** The raw `auto_monitor` pref — the state of the settings toggle, nothing more. */
      globalToggle: getBool(prefMap, "auto_monitor"),
      /** Projects whose resolved Start Mode makes them monitor-driven regardless of the toggle. */
      monitorDrivenProjectCount: drivenProjectIds.size,
      intervalMin: parseInt(prefMap.get("auto_monitor_interval") || "4", 10),
      /** Is a timer armed for a future cycle? (NOT "is a cycle running" — see cycleInFlight.) */
      active: monitorState.timer !== null,
      /** Is a cycle executing right now? */
      cycleInFlight,
      lastRun: monitorState.lastRun,
      currentCycle: monitorState.currentCycle,
      // While a cycle is in flight this was misleading: the armed timer's fire time was reported as
      // "next run" even though the re-entrancy guard will drop that trigger, and the end-of-cycle
      // rerun fires within seconds instead (measured 5-8s gaps between cycles, not the configured
      // 4 minutes). A countdown of "4 min" beside a cycle that has been running for 7 is worse than
      // no countdown, so the honest answer while a cycle runs is "as soon as this one finishes".
      nextRunAt: cycleInFlight ? null : monitorState.nextRunAt,
      recentActions: monitorState.recentActions,
      resourceSnapshot,
      warnings: monitorState.warnings,
      lastHealthCheckAt: monitorState.lastHealthCheckAt,
      // Unread by any client — verbose-only (see the payload-diet note above).
      ...(verbose ? { lastCyclePhaseTimings: monitorState.lastCyclePhaseTimings } : {}),
      maintenanceActive,
      maintenanceEnd,
    };
    // Conditional GET (#400's helper): the monitor's state changes on the minutes
    // scale, so most 30s polls collapse to a bodyless 304.
    return conditionalJsonResponse(JSON.stringify(payload), c.req.header("If-None-Match"));
  });
}

export function createMonitorSetup({ sessionManager, boardEvents, serverPort, reviewSessionIds, fixAndMergeSessionIds }: MonitorSetupDeps) {
  const monitorState: MonitorState = { timer: null, nextRunAt: null, lastRun: null, currentIntervalMin: null, recentActions: [], lastResourceSnapshot: null, warnings: [], lastHealthCheckAt: null, currentCycle: null, lastCyclePhaseTimings: null };
  // One workspace-actions port for the monitor's relaunch/merge/fix/delete drives,
  // wired here in the composition root so the cycle calls the application service
  // directly instead of self-HTTP. (serverPort is still used by auto-start/backlog.)
  const workspaceActions = createMonitorWorkspaceActions({
    database: db,
    getSessionManager: () => sessionManager,
    boardEvents,
    fixAndMergeSessionIds,
  });
  let lastWarningFingerprint = "";
  // `monitorState.warnings` is the UNION of two independently-produced sets, and the refresh
  // REPLACES its half rather than adding to it. Before #349 that was expressed as strict phase
  // ordering inside the cycle (refresh, then append) — which is unrepresentable now that the
  // refresh is off the cycle. Keeping the two halves separately and recomposing on every write
  // means neither can silently drop the other whatever order they land in.
  let lastScannedWarnings: MonitorWarning[] = [];
  let autoStartSkipWarnings: MonitorWarning[] = [];
  let lastWarningRefreshAt = 0;
  let warningRefreshRunning = false;
  // #416: cross-cycle project scheduling state — carry-over cursor + per-project activity.
  // In-memory by design: a restart starts coverage over, which is fine (none of it is
  // correctness state; the first post-restart cycle treats every project as due).
  const projectScheduler = createMonitorProjectScheduler();
  function composeWarnings(): MonitorWarning[] {
    monitorState.warnings = [...lastScannedWarnings, ...autoStartSkipWarnings];
    return monitorState.warnings;
  }

  // Event-driven trigger state. The deterministic monitor is poll-based by default
  // (auto_monitor_interval), but most of its work is a reaction to a board mutation we
  // already know about in-process (a merge just landed → start the next unblocked ticket;
  // a session exited → relaunch/refill). Rather than wait up to one poll interval, board
  // events fire a debounced, re-entrancy-guarded cycle ~immediately. The poll remains as a
  // safety net for time-based / event-less conditions (stale detection, crash recovery,
  // external git changes, orphaned-worktree sweep).
  let cycleRunning = false;
  let rerunRequested = false;
  let triggerTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const EVENT_TRIGGER_DEBOUNCE_MS = 1500;
  function triggerMonitorSoon() {
    if (stopped) return;
    if (triggerTimer) return; // a trigger is already pending — coalesce this burst into it
    triggerTimer = setTimeout(() => {
      triggerTimer = null;
      if (stopped) return;
      runMonitorCycle().catch(() => {});
    }, EVENT_TRIGGER_DEBOUNCE_MS);
    (triggerTimer).unref?.();
  }
  async function refreshMonitorWarnings(prefMap?: Map<string, string>) {
    const prefs = prefMap ?? new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
    const warnings: MonitorWarning[] = [
      ...await scanDirtyMainCheckouts(db),
      ...await scanAutodriveStallWarnings(db, prefs),
    ];
    lastScannedWarnings = warnings;
    composeWarnings();
    monitorState.lastHealthCheckAt = new Date().toISOString();
    const warningFingerprint = warnings
      .map((warning) => {
        if ("files" in warning) {
          return `dirty_main:${warning.projectId}:${warning.files.join("|")}`;
        }
        return `${warning.type}:${warning.projectId}:${warning.cause}:${warning.lastProgressAt}:${warning.workspaceIds.join("|")}`;
      })
      .join(";");
    if (warningFingerprint && warningFingerprint !== lastWarningFingerprint) {
      for (const warning of warnings) {
        const suffix = "repoPath" in warning ? ` (${warning.repoPath})` : "";
        console.warn(`[monitor] ${warning.message}${suffix}`);
      }
    }
    lastWarningFingerprint = warningFingerprint;
    return monitorState.warnings;
  }

  /**
   * The ONLY sanctioned entry point for the diagnostic scan (#349). Single-flight + rate-limited,
   * and never throws — a diagnostic must not be able to fail or delay its caller. Callers do not
   * await it; they fire and forget.
   */
  function refreshMonitorWarningsThrottled(prefMap?: Map<string, string>, force = false): void {
    if (stopped) return;
    // #416: beyond the #349 single-flight + rate limit, only START the scan in a genuinely
    // idle window — no cycle in flight AND a calm event loop — since nothing reads its output
    // on any deadline. Deferral is capped (~30 min) inside the gate so it still eventually
    // runs on a permanently-busy board. `getLoopLagMonitor()` is null in unit tests → calm.
    const lagStats = getLoopLagMonitor()?.stats() ?? null;
    if (!shouldStartHealthRefresh({
      nowMs: Date.now(),
      lastStartedAtMs: lastWarningRefreshAt,
      refreshRunning: warningRefreshRunning,
      intervalMs: HEALTH_WARNING_REFRESH_INTERVAL_MS,
      cycleInFlight: cycleRunning,
      loopLagP90Ms: lagStats ? lagStats.p90 : null,
      force,
    })) return;
    warningRefreshRunning = true;
    // Stamped BEFORE the scan, not after: stamping on completion would let a scan that takes
    // longer than the interval re-arm the instant it finished, restoring the back-to-back
    // behaviour this guard exists to remove.
    lastWarningRefreshAt = Date.now();
    void refreshMonitorWarnings(prefMap)
      .catch((err) => console.warn("[monitor] health warning refresh failed (diagnostics only):", err instanceof Error ? err.message : String(err)))
      .finally(() => { warningRefreshRunning = false; });
  }

  function isInMaintenanceWindow(prefMap: Map<string, string>): boolean {
    if (!getBool(prefMap, "monitor_maintenance_window_enabled")) return false;
    const endTime = prefMap.get("monitor_maintenance_window_end");
    if (!endTime) return true;
    return new Date(endTime).getTime() > Date.now();
  }

  async function runMonitorCycle(force = false) {
    if (stopped) return;
    // Re-entrancy guard: an event-triggered cycle must never overlap a scheduled one —
    // two concurrent cycles could both see the same unblocked issue (no open workspace yet)
    // and each POST a workspace, double-starting it. If a trigger arrives mid-cycle, note it
    // and run exactly one more pass at the end so freshly-unblocked work isn't missed.
    if (cycleRunning) { rerunRequested = true; return; }
    cycleRunning = true;
    monitorState.currentCycle = { startedAt: new Date().toISOString(), phase: "starting" };
    // Time every phase transition, not just name the current one (#347).
    const phaseRecorder = createMonitorPhaseRecorder("starting");
    // ...and carry this cycle's own ENVIRONMENTAL BASELINE (#368). On this machine the same
    // zero-repository-work git spawn MEASURED 68ms to 10203ms in bursts, so a cycle's timings mean
    // nothing without a simultaneous control taken through the same adapter. Sampled at cycle start,
    // at throttled phase transitions, and at cycle end — a single sample cannot see a burst that
    // starts mid-cycle. See `monitor-spawn-control.ts`.
    const controlProbe = createSpawnControlProbe();
    const setPhase = (phase: string) => {
      phaseRecorder.enter(phase);
      controlProbe.requestSample(phase);
      if (monitorState.currentCycle) monitorState.currentCycle = { ...monitorState.currentCycle, phase };
    };
    // Only cycles that do work get sampled: a tick that bails on `monitorShouldRun` should not spawn
    // anything at all, and one lone end-of-cycle sample would be a control with nothing to control.
    let cycleDidWork = false;
    const cycleStats = { relaunched: 0, merged: 0, nudged: 0 };
    const cycleStartMs = Date.now();
    let deferredProjectIds: string[] = [];
    let skippedProjectIds: string[] = [];
    let notStartedProjectIds: string[] = [];
    let resourceSummary: MonitorResourceSummary | null = null;
    let warningCount = monitorState.warnings.length;
    try {
      setPhase("loading-preferences");
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
      if (!force && !monitorShouldRun(prefMap)) return;
      cycleDidWork = true;
      // Deliberately NOT awaited. Instrumentation must not sit on the cycle's critical path: awaiting
      // it here delayed the cycle's first real action by one git spawn — MEASURED at 1.9-10.4s inside
      // a stall — which is both a real slowdown and a self-fulfilling one (the probe would lengthen
      // the very cycle it is measuring). Fire-and-forget still lands the sample in this cycle's
      // measurement window, and `finish()` awaits it. Its `totalMs` then overlaps the cycle's early
      // work, which is correct: that is exactly the queue latency the real operations also pay, and
      // `childMs` still isolates the process's own cost.
      void controlProbe.sample("cycle-start");
      // Scope this cycle's actions: when the global toggle is on, act on every project
      // (legacy behaviour); otherwise act only on projects whose resolved Start Mode is
      // `monitor`. Routing through `resolveStartPolicy` (not the raw `board_autodrive` flag)
      // makes `manual` a TRUE kill-switch — relaunch/nudge/auto-merge no longer leak past it
      // for a project with a stale `board_autodrive=true` — and stands the in-process engine
      // down for `conductor` projects (the external loop drives those). §3.4 of the
      // 2026-07-07 adversarial architecture review.
      const globalOn = getBool(prefMap, "auto_monitor");
      const allowProject = (projectId: string) => globalOn || resolveStartPolicy(prefMap, projectId).mode === "monitor";
      // Auto-start, backlog refill, and backlog-pull eligibility all consult the project's
      // resolved Start Mode (the single source of truth) — NOT the raw flags above. The mode
      // supersedes the global toggle per-project; `manual` is a true stop. (`allowProject`
      // above still scopes mechanism-2 relaunch/merge of already-in-progress work.)
      const shouldAutoStartProject = (projectId: string) => resolveStartPolicy(prefMap, projectId).autoStartUnblocked;
      const allowBacklogRefill = (projectId: string) => resolveStartPolicy(prefMap, projectId).backlogRefill;
      if (isInMaintenanceWindow(prefMap)) {
        setPhase("maintenance-window");
        refreshMonitorWarningsThrottled(prefMap);
        const endTime = prefMap.get("monitor_maintenance_window_end");
        console.log(`[monitor] Maintenance window active — skipping disruptive actions${endTime ? ` until ${endTime}` : ""}`);
        return;
      }
      const mergeStrategy = resolveMergeStrategy(prefMap);
      // NOTE: the warnings refresh used to run HERE, third of eleven phases, ahead of every
      // productive phase. It is pure diagnostics — nothing in the cycle reads its output — but
      // it scans every project's active workspaces, so on a busy board it became a multi-minute
      // serial prefix that delayed auto-start on EVERY cycle. Measured: `currentCycle.phase`
      // parked at `refreshing-warnings` for minutes at a time with 44 active workspaces, while a
      // freshly-planned ticket sat unstarted. It now runs after auto-start (see below), so a
      // slow diagnostic can no longer hold up starting real work.
      // Stale-process hygiene is best-effort and must NEVER abort the cycle: it runs BEFORE
      // the productive phases, so anything it throws costs the board an entire round of
      // relaunches, merges, loop advances and auto-starts. Measured: process enumeration
      // timing out on a loaded box killed cycle after cycle, and the only symptom was a board
      // that quietly stopped starting planned tickets (see #339). The shell-outs inside also
      // include netstat, so catching at this level covers every one of them, not just the
      // process list.
      setPhase("resource-sweep");
      const resourceSnapshot = await snapshotAndCleanStaleDevProcesses(db).catch((err: unknown) => {
        console.warn(`[monitor] resource sweep failed (continuing with the cycle): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (resourceSnapshot) {
        monitorState.lastResourceSnapshot = resourceSnapshot;
        resourceSummary = {
          processCount: resourceSnapshot.processes.length,
          listenerCount: resourceSnapshot.listeners.length,
          activeWorkspaceCount: resourceSnapshot.activeWorkspaces.length,
          keptCount: resourceSnapshot.kept.length,
          cleanedCount: resourceSnapshot.cleaned.filter((item) => item.action === "cleaned").length,
          cleanupFailedCount: resourceSnapshot.cleaned.filter((item) => item.action === "cleanup_failed").length,
        };
      }
      if (resourceSummary) {
        console.log(
          `[monitor] Resource snapshot: processes=${resourceSummary.processCount} listeners=${resourceSummary.listenerCount} ` +
          `activeWorkspaces=${resourceSummary.activeWorkspaceCount} kept=${resourceSummary.keptCount} cleaned=${resourceSummary.cleanedCount} failed=${resourceSummary.cleanupFailedCount}`,
        );
      }
      setPhase("loading-candidates");
      const activeStatuses = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} NOT IN ('Done', 'Cancelled')`);
      const activeStatusIds = activeStatuses.map((s) => s.id);
      if (activeStatusIds.length === 0) return;
      const candidates = await db.select({ wsId: workspaces.id, wsStatus: workspaces.status, workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, projectId: issues.projectId, issueId: issues.id, issueTitle: issues.title, issueNumber: issues.issueNumber, issueStatusName: projectStatuses.name, baseBranch: workspaces.baseBranch, readyForMerge: workspaces.readyForMerge, diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged, diffStatCacheInsertions: workspaces.diffStatCacheInsertions, diffStatCacheDeletions: workspaces.diffStatCacheDeletions, mergeGateRanAt: workspaces.mergeGateRanAt, mergeGateStage: workspaces.mergeGateStage, mergeGateSource: workspaces.mergeGateSource, mergeGateBranchSha: workspaces.mergeGateBranchSha, mergeGateBaseSha: workspaces.mergeGateBaseSha }).from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id)).innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
        .where(sql`${workspaces.status} != 'closed' AND (
          (${issues.currentNodeId} IS NOT NULL AND (${workflowNodes.nodeType} IS NULL OR ${workflowNodes.nodeType} != 'end'))
          OR (${issues.currentNodeId} IS NULL AND ${issues.statusId} IN (${sql.join(activeStatusIds.map((id) => sql`${id}`), sql`, `)}))
        )`);
      const allowedCandidates = candidates.filter((candidate) => allowProject(candidate.projectId));
      // #416: plan which projects this cycle walks. The scheduler rotates the order to the
      // carry-over cursor (a budget-stopped cycle's tail becomes this cycle's head) and
      // skips projects with no board activity since their last COMPLETED sub-pass (a slow
      // ~15-min floor still forces a pass, catching external/out-of-band mutations).
      const candidateProjectOrder: string[] = [];
      const seenProjects = new Set<string>();
      for (const candidate of allowedCandidates) {
        if (!seenProjects.has(candidate.projectId)) {
          seenProjects.add(candidate.projectId);
          candidateProjectOrder.push(candidate.projectId);
        }
      }
      const cyclePlan = projectScheduler.planCycle(candidateProjectOrder);
      skippedProjectIds = cyclePlan.skipped;
      if (cyclePlan.skipped.length > 0) {
        console.log(`[monitor] Skipping ${cyclePlan.skipped.length} inactive project(s) this cycle (no board activity since their last sub-pass; slow floor still applies)`);
      }
      const planIndex = new Map(cyclePlan.toRun.map((id, i) => [id, i]));
      // Stable sort: candidates keep their relative order within a project; project groups
      // are walked in plan order so the cursor project is processed first.
      const scheduledCandidates = allowedCandidates
        .filter((candidate) => planIndex.has(candidate.projectId))
        .sort((a, b) => (planIndex.get(a.projectId) ?? 0) - (planIndex.get(b.projectId) ?? 0));
      // #416: global cycle wall-clock budget — 2/3 of the interval by default (pref
      // `monitor_cycle_budget_ms` overrides). Measured against the cycle's own start, so
      // the resource sweep and candidate loading already count against it.
      const intervalMinForBudget = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
      const budgetPrefMs = Number(prefMap.get("monitor_cycle_budget_ms"));
      const cycleBudgetMs = Number.isFinite(budgetPrefMs) && budgetPrefMs > 0
        ? budgetPrefMs
        : Math.round((Number.isFinite(intervalMinForBudget) && intervalMinForBudget > 0 ? intervalMinForBudget : 4) * 60_000 * CYCLE_BUDGET_INTERVAL_FRACTION);
      const autoMergeDisabledProjectIds = new Set(
        [...prefMap]
          .filter(([key, value]) => /^auto_merge_disabled_[0-9a-f-]+$/.test(key) && value === "true")
          .map(([key]) => key.replace("auto_merge_disabled_", "")),
      );
      setPhase("processing-candidates");
      const candidateResult = await processWorkspaceCandidates(scheduledCandidates, {
        sessionManager,
        boardEvents,
        workspaceActions,
        autoMergeEnabled: isAutoMergeEnabled(prefMap) && mergeStrategy === "monitor",
        autoMergeInReview: getBool(prefMap, "auto_merge_in_review"),
        autoMergeDisabledProjectIds,
        reviewSessionIds,
        monitorRecentActions: monitorState.recentActions,
        logMonitorAction,
        buildMonitorNudgePrompt,
        getRecentAgentExcerpts,
        shouldSkipNudge,
        stuckBuilderTimeoutMs: (() => {
          const minutes = Number(prefMap.get("monitor_stuck_builder_timeout_min"));
          return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : undefined;
        })(),
        projectTimeBudgetMs: (() => {
          const ms = Number(prefMap.get("monitor_project_time_budget_ms"));
          return Number.isFinite(ms) && ms > 0 ? ms : undefined;
        })(),
        candidateTimeoutMs: (() => {
          const ms = Number(prefMap.get("monitor_candidate_timeout_ms"));
          return Number.isFinite(ms) && ms > 0 ? ms : undefined;
        })(),
        cycleDeadlineMs: cycleStartMs + cycleBudgetMs,
      });
      cycleStats.relaunched = candidateResult.relaunched;
      cycleStats.merged = candidateResult.merged;
      cycleStats.nudged = candidateResult.nudged;
      deferredProjectIds = candidateResult.deferredProjectIds;
      notStartedProjectIds = candidateResult.notStartedProjectIds;
      // #416: stamp completed sub-passes (consuming their pre-completion activity, including
      // the walk's own broadcasts) and set the carry-over cursor to the first planned project
      // that did NOT complete, so the next cycle resumes there instead of restarting at #1.
      projectScheduler.recordCycleResult({ planned: cyclePlan.toRun, completed: candidateResult.completedProjectIds });
      // Gated auto-contract (#918): BEFORE fan-out, contract (or suggest contracting) coupled
      // components so coupled tickets never start as separate conflicting workspaces. Off by
      // default — only projects with `auto_contract_coupled_<id>` set act, and only those the
      // monitor would otherwise auto-start work for (same gate as runAutoStart below).
      setPhase("auto-contract");
      await runAutoContract(prefMap, { boardEvents, allowProject: shouldAutoStartProject, logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
      // Compounding "setup once" pass (#127): a project that has accumulated enough merged
      // work gets its harness scaffolded ONCE, between tickets, so every later builder
      // inherits it instead of re-discovering the environment. Runs BEFORE the fan-out so a
      // workspace started this cycle already forks from the branch the pass committed to.
      setPhase("compounding-setup");
      await runCompoundingSetup(prefMap, { allowProject: shouldAutoStartProject });
      // Board-owned plugin loops (manifest `loops`): plan the next round of a converging
      // analysis loop once the previous round's tickets are all terminal — same WIP limit,
      // same provider selection, same auth-rotation-on-quota as any other ticket.
      //
      // Runs BEFORE the auto-start fan-out, and after the candidate pass that lands merges,
      // so one cycle can do the whole hop: this cycle's merge makes the round terminal, the
      // advance plans the next unit, and this cycle's `runAutoStart` launches it. It used to
      // run last, which guaranteed a freshly-planned loop ticket missed the auto-start pass
      // and had to wait for the NEXT cycle — a floor of one full cycle (~4 min by default,
      // and far worse under load: a measured pm-pipeline step waited 27 min to start).
      setPhase("plugin-loops");
      // The no-op-advance rate limit (#372) is the CONFIGURED monitor interval, not the cycle
      // cadence — cycles are also event-triggered, so without this a gate-blocked loop was
      // re-planned every ~90s under a 240s interval.
      await advanceDuePluginLoops(db, {
        allowProject: shouldAutoStartProject,
        minBlockedAdvanceIntervalMs: (() => {
          const minutes = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
          return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : undefined;
        })(),
      });
      setPhase("auto-start");
      const autoStartSkips = await runAutoStart(prefMap, { serverPort, boardEvents, allowProject: shouldAutoStartProject, isAutoDrivenProject: (projectId) => resolveStartPolicy(prefMap, projectId).mode !== "manual", logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
      // #349: the diagnostic scan used to be a phase HERE and was awaited. It is now on its own
      // rate-limited timer (see `HEALTH_WARNING_REFRESH_INTERVAL_MS`) and the cycle does not wait
      // for it — 203-265s of purely diagnostic work per cycle is off the critical path. Do not
      // reintroduce an `await` here: nothing in the cycle reads the warnings, and the only thing
      // that awaiting bought was blocking the event loop for minutes on every pass. The two halves
      // of `monitorState.warnings` are now recomposed rather than ordered (`composeWarnings`), so
      // the append below can no longer be clobbered by a refresh that lands beside it.
      setPhase("auto-start-skip-warnings");
      autoStartSkipWarnings = [];
      if (autoStartSkips.size > 0) {
        const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects)
          .where(inArray(projects.id, [...autoStartSkips.keys()]));
        const projectNames = new Map(projectRows.map((p) => [p.id, p.name]));
        const skipWarnings = buildAutoStartSkipWarnings(autoStartSkips, projectNames, new Date());
        if (skipWarnings.length > 0) {
          autoStartSkipWarnings = skipWarnings;
          for (const warning of skipWarnings) console.warn(`[monitor] ${warning.message}`);
        }
      }
      warningCount = composeWarnings().length;
      // After the plugin-loop advance above, so a loop ticket planned this cycle counts as
      // real backlog work and the refill does not generate spurious tickets beside it.
      setPhase("backlog-refill");
      await runBacklogEmptyStrategy(prefMap, { serverPort, boardEvents, allowProject: allowBacklogRefill, logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
    } catch (err) {
      console.warn("[monitor] Cycle error:", err);
    } finally {
      // The closing control sample must be taken BEFORE `finish()` closes the cycle's measurement
      // window, so it lands in the same window as the work it qualifies (#368). `finish()` stays
      // synchronous; the probe's report is awaited and handed to it.
      //
      // It must also be taken before `currentCycle` is cleared. Awaiting a spawn AFTER clearing it
      // opened a window in which `currentCycle` was null and `lastRun` was still null — the exact
      // "a wedged cycle looks identical to never ran" state #208 exists to prevent, and on this
      // machine that window is as long as a stalled `git --version` (MEASURED up to 10.2s). Holding
      // the re-entrancy guard across it is correct: the cycle is not finished until it is recorded.
      if (cycleDidWork) await controlProbe.sample("cycle-end");
      const controlReport = await controlProbe.finish();
      cycleRunning = false;
      monitorState.currentCycle = null;
      monitorState.lastCyclePhaseTimings = phaseRecorder.finish(controlReport);
      monitorState.lastRun = {
        at: new Date().toISOString(),
        ...cycleStats,
        resources: resourceSummary,
        warnings: warningCount,
        ...(deferredProjectIds.length > 0 ? { deferredProjectIds } : {}),
        ...(skippedProjectIds.length > 0 ? { skippedProjectIds } : {}),
        ...(notStartedProjectIds.length > 0 ? { notStartedProjectIds } : {}),
      };
      const prefRows = await db.select().from(preferences).catch(() => []);
      const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
      if (monitorShouldRun(prefMap)) {
        const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
        monitorState.nextRunAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
        // Always clear the previous timer before re-arming: event-triggered runs call
        // runMonitorCycle directly (not via the timer), so without this the old periodic
        // timer would leak and accumulate, firing redundant cycles.
        if (monitorState.timer) clearTimeout(monitorState.timer);
        monitorState.timer = setTimeout(() => void runMonitorCycle(), intervalMin * 60 * 1000);
      } else {
        monitorState.nextRunAt = null;
      }
      // A board mutation arrived while this cycle was running — run one more pass promptly
      // so we don't strand freshly-unblocked work until the next poll.
      if (!stopped && rerunRequested) { rerunRequested = false; triggerMonitorSoon(); }
    }
  }

  async function syncMonitorState() {
    const prefRows = await db.select().from(preferences).catch(() => []);
    const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
    // #349: this ran every 30s (the `syncMonitorInterval` period) and was AWAITED, with no
    // re-entrancy guard — so a scan measured at 203-265s had ~8 copies of itself in flight at
    // any moment, each blocking the event loop, and it also delayed the timer re-arm below.
    // Now fire-and-forget through the shared throttle.
    refreshMonitorWarningsThrottled(prefMap);
    if (stopped) return;
    const enabled = monitorShouldRun(prefMap);
    const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
    if (enabled && (!monitorState.timer || intervalMin !== monitorState.currentIntervalMin)) {
      if (monitorState.timer && intervalMin !== monitorState.currentIntervalMin) {
        console.log(`[monitor] Interval changed to ${intervalMin}m — restarting monitor immediately`);
        clearTimeout(monitorState.timer);
        monitorState.timer = null;
      } else {
        console.log(`[monitor] Starting board monitoring loop (every ${intervalMin}m) — running immediately`);
      }
      monitorState.currentIntervalMin = intervalMin;
      monitorState.nextRunAt = null;
      monitorState.timer = setTimeout(() => {}, 0);
      runMonitorCycle().catch(() => {});
    } else if (!enabled && monitorState.timer) {
      console.log("[monitor] Stopping board monitoring loop");
      clearTimeout(monitorState.timer);
      monitorState.timer = null;
      monitorState.nextRunAt = null;
      monitorState.currentIntervalMin = null;
    }
  }

  // Resource hygiene runs INDEPENDENT of board orchestration: even when auto_monitor
  // is off (e.g. an external monitor loop drives the board), leftover worktree dev
  // servers must still be reaped. When auto_monitor is on, its own cycle already
  // sweeps, so this standalone pass steps aside to avoid double work.
  async function runStandaloneResourceSweep(force = false): Promise<BoardMonitorResourceSnapshot | null> {
    try {
      if (!force) {
        const prefRows = await db.select().from(preferences).catch(() => []);
        const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
        if (monitorShouldRun(prefMap)) return null;
      }
      const snapshot = await snapshotAndCleanStaleDevProcesses(db);
      monitorState.lastResourceSnapshot = snapshot;
      const cleaned = snapshot.cleaned.filter((d) => d.action === "cleaned").length;
      if (cleaned > 0) console.log(`[resource-sweep] reaped ${cleaned} stale worktree dev tree(s)`);
      return snapshot;
    } catch (err) {
      console.warn("[resource-sweep] failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  // Subscribe the deterministic monitor to in-process board mutations. broadcast() invokes
  // every invalidation listener on merge / session-exit / ticket-created / etc., so a just-
  // merged ticket triggers the next unblocked one within EVENT_TRIGGER_DEBOUNCE_MS instead of
  // up to a full poll interval later. The cycle itself early-returns when nothing is auto-
  // driven and is idempotent, so events for non-driven projects cost at most one no-op pass.
  // Every board mutation carries its projectId — that is the #416 activity signal the
  // scheduler uses to skip projects with nothing new since their last completed sub-pass.
  const invalidationListener = (projectId: string) => {
    projectScheduler.recordActivity(projectId);
    triggerMonitorSoon();
  };
  boardEvents.addInvalidationListener(invalidationListener);

  const syncMonitorInterval = setInterval(() => void syncMonitorState(), 30_000);
  syncMonitorInterval.unref?.();
  syncMonitorState().catch(() => {});
  // #399 (decision 014): the summary-projection heal pass PIGGYBACKS this existing
  // 5-minute timer (bounded batch of the dirtiest workspaces) — do not give it its own.
  const resourceSweepInterval = setInterval(() => {
    void runStandaloneResourceSweep();
    void healWorkspaceSummaryProjection(db);
  }, 5 * 60_000);
  resourceSweepInterval.unref?.();
  runStandaloneResourceSweep().catch(() => {});
  void healWorkspaceSummaryProjection(db);
  return {
    setupMonitorRoutes: (app: Hono) => setupMonitorRoutes(app, monitorState, runMonitorCycle, syncMonitorState, runStandaloneResourceSweep),
    monitorState,
    stop: () => {
      stopped = true;
      boardEvents.removeInvalidationListener(invalidationListener);
      if (triggerTimer) {
        clearTimeout(triggerTimer);
        triggerTimer = null;
      }
      if (monitorState.timer) {
        clearTimeout(monitorState.timer);
        monitorState.timer = null;
      }
      clearInterval(syncMonitorInterval);
      clearInterval(resourceSweepInterval);
    },
  };
}
