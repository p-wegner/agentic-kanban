import { issues, preferences, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { createSessionManager } from "../services/session.manager.js";
import { runAutoStart } from "./monitor-auto-start.js";
import { runBacklogEmptyStrategy } from "./monitor-backlog.js";
import { getRecentAgentExcerpts, logMonitorAction, shouldSkipNudge, type MonitorAction } from "./monitor-helpers.js";
import { processWorkspaceCandidates } from "./monitor-cycle.js";
import { buildMonitorNudgePrompt } from "./review-helpers.js";
import { snapshotAndCleanStaleDevProcesses, type BoardMonitorResourceSnapshot } from "../services/stale-dev-processes.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";
import { scanDirtyMainCheckouts, type DirtyMainCheckoutWarning } from "../services/dirty-main-checkout.js";
import { scanAutodriveStallWarnings, type AutodriveStallWarning } from "../services/autodrive-stall-warning.service.js";
import { resolveMergeStrategy } from "./merge-strategy.js";

/**
 * Per-project hands-off mode. A `board_autodrive_<projectId>` preference set to
 * "true" opts that project into autonomous driving (auto-start / relaunch / refill)
 * EVEN WHEN the global `auto_monitor` toggle is off. This is what lets a freshly-
 * registered project be developed hands-off: the monitor engine already iterates all
 * projects, so a durable per-project flag is enough. The flag is a separate pref key,
 * so the boot-time reset of the GLOBAL `auto_monitor` (startup-tasks.ts) never clobbers it.
 */
const AUTODRIVE_KEY_RE = /^board_autodrive_([0-9a-f-]+)$/;
export function autoDriveProjectIds(prefMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of prefMap) {
    const m = AUTODRIVE_KEY_RE.exec(key);
    if (m && value === "true") ids.add(m[1]);
  }
  return ids;
}
/** The monitor cycle should run/reschedule when the global toggle is on OR any project is auto-driven. */
export function monitorShouldRun(prefMap: Map<string, string>): boolean {
  return prefMap.get("auto_monitor") === "true" || autoDriveProjectIds(prefMap).size > 0;
}

export interface MonitorState {
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: string | null;
  lastRun: { at: string; relaunched: number; merged: number; nudged: number; resources: MonitorResourceSummary | null; warnings: number } | null;
  currentIntervalMin: number | null;
  recentActions: MonitorAction[];
  lastResourceSnapshot: BoardMonitorResourceSnapshot | null;
  warnings: MonitorWarning[];
  lastHealthCheckAt: string | null;
}

export type MonitorWarning = DirtyMainCheckoutWarning | AutodriveStallWarning;

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
}

export function setupMonitorRoutes(app: Hono, monitorState: MonitorState, runMonitorCycle: (force?: boolean) => Promise<void>, _syncMonitorState: () => Promise<void>, runResourceSweep?: (force?: boolean) => Promise<BoardMonitorResourceSnapshot | null>) {
  app.post("/api/internal/monitor-run", async (c) => {
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
    const prefRows = await db.select().from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const maintenanceEnabled = prefMap.get("monitor_maintenance_window_enabled") === "true";
    const maintenanceEnd = prefMap.get("monitor_maintenance_window_end") || null;
    const maintenanceActive = maintenanceEnabled && (!maintenanceEnd || new Date(maintenanceEnd).getTime() > Date.now());
    return c.json({ enabled: prefMap.get("auto_monitor") === "true", intervalMin: parseInt(prefMap.get("auto_monitor_interval") || "4", 10), active: monitorState.timer !== null, lastRun: monitorState.lastRun, nextRunAt: monitorState.nextRunAt, recentActions: monitorState.recentActions, resourceSnapshot: monitorState.lastResourceSnapshot, warnings: monitorState.warnings, lastHealthCheckAt: monitorState.lastHealthCheckAt, maintenanceActive, maintenanceEnd });
  });
}

export function createMonitorSetup({ sessionManager, boardEvents, serverPort, reviewSessionIds }: MonitorSetupDeps) {
  const monitorState: MonitorState = { timer: null, nextRunAt: null, lastRun: null, currentIntervalMin: null, recentActions: [], lastResourceSnapshot: null, warnings: [], lastHealthCheckAt: null };
  let lastWarningFingerprint = "";

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
    (triggerTimer as NodeJS.Timeout).unref?.();
  }
  async function refreshMonitorWarnings(prefMap?: Map<string, string>) {
    const prefs = prefMap ?? new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
    const warnings: MonitorWarning[] = [
      ...await scanDirtyMainCheckouts(db),
      ...await scanAutodriveStallWarnings(db, prefs),
    ];
    monitorState.warnings = warnings;
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
    return warnings;
  }

  function isInMaintenanceWindow(prefMap: Map<string, string>): boolean {
    if (prefMap.get("monitor_maintenance_window_enabled") !== "true") return false;
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
    const cycleStats = { relaunched: 0, merged: 0, nudged: 0 };
    let resourceSummary: MonitorResourceSummary | null = null;
    let warningCount = monitorState.warnings.length;
    try {
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
      if (!force && !monitorShouldRun(prefMap)) return;
      // Scope this cycle's actions: when the global toggle is on, act on every project
      // (legacy behaviour); otherwise act only on projects in per-project hands-off mode.
      const globalOn = prefMap.get("auto_monitor") === "true";
      const driveIds = autoDriveProjectIds(prefMap);
      const allowProject = (projectId: string) => globalOn || driveIds.has(projectId);
      // Auto-start, backlog refill, and backlog-pull eligibility all consult the project's
      // resolved Start Mode (the single source of truth) — NOT the raw flags above. The mode
      // supersedes the global toggle per-project; `manual` is a true stop. (`allowProject`
      // above still scopes mechanism-2 relaunch/merge of already-in-progress work.)
      const shouldAutoStartProject = (projectId: string) => resolveStartPolicy(prefMap, projectId).autoStartUnblocked;
      const allowBacklogRefill = (projectId: string) => resolveStartPolicy(prefMap, projectId).backlogRefill;
      if (isInMaintenanceWindow(prefMap)) {
        warningCount = (await refreshMonitorWarnings(prefMap)).length;
        const endTime = prefMap.get("monitor_maintenance_window_end");
        console.log(`[monitor] Maintenance window active — skipping disruptive actions${endTime ? ` until ${endTime}` : ""}`);
        return;
      }
      const mergeStrategy = resolveMergeStrategy(prefMap);
      warningCount = (await refreshMonitorWarnings(prefMap)).length;
      const resourceSnapshot = await snapshotAndCleanStaleDevProcesses(db);
      monitorState.lastResourceSnapshot = resourceSnapshot;
      resourceSummary = {
        processCount: resourceSnapshot.processes.length,
        listenerCount: resourceSnapshot.listeners.length,
        activeWorkspaceCount: resourceSnapshot.activeWorkspaces.length,
        keptCount: resourceSnapshot.kept.length,
        cleanedCount: resourceSnapshot.cleaned.filter((item) => item.action === "cleaned").length,
        cleanupFailedCount: resourceSnapshot.cleaned.filter((item) => item.action === "cleanup_failed").length,
      };
      console.log(
        `[monitor] Resource snapshot: processes=${resourceSummary.processCount} listeners=${resourceSummary.listenerCount} ` +
        `activeWorkspaces=${resourceSummary.activeWorkspaceCount} kept=${resourceSummary.keptCount} cleaned=${resourceSummary.cleanedCount} failed=${resourceSummary.cleanupFailedCount}`,
      );
      const activeStatuses = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} NOT IN ('Done', 'Cancelled')`);
      const activeStatusIds = activeStatuses.map((s) => s.id);
      if (activeStatusIds.length === 0) return;
      const candidates = await db.select({ wsId: workspaces.id, wsStatus: workspaces.status, workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, projectId: issues.projectId, issueId: issues.id, issueTitle: issues.title, issueNumber: issues.issueNumber, issueStatusName: projectStatuses.name, baseBranch: workspaces.baseBranch, readyForMerge: workspaces.readyForMerge, diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged, diffStatCacheInsertions: workspaces.diffStatCacheInsertions, diffStatCacheDeletions: workspaces.diffStatCacheDeletions }).from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id)).innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
        .where(sql`${workspaces.status} != 'closed' AND (
          (${issues.currentNodeId} IS NOT NULL AND (${workflowNodes.nodeType} IS NULL OR ${workflowNodes.nodeType} != 'end'))
          OR (${issues.currentNodeId} IS NULL AND ${issues.statusId} IN (${sql.join(activeStatusIds.map((id) => sql`${id}`), sql`, `)}))
        )`);
      const allowedCandidates = candidates.filter((candidate) => allowProject(candidate.projectId));
      const autoMergeDisabledProjectIds = new Set(
        [...prefMap]
          .filter(([key, value]) => /^auto_merge_disabled_[0-9a-f-]+$/.test(key) && value === "true")
          .map(([key]) => key.replace("auto_merge_disabled_", "")),
      );
      Object.assign(cycleStats, await processWorkspaceCandidates(allowedCandidates, {
        sessionManager,
        boardEvents,
        serverPort,
        autoMergeEnabled: prefMap.get("auto_merge") === "true" && mergeStrategy === "monitor",
        autoMergeInReview: prefMap.get("auto_merge_in_review") === "true",
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
      }));
      await runAutoStart(prefMap, { serverPort, boardEvents, allowProject: shouldAutoStartProject, isAutoDrivenProject: (projectId) => resolveStartPolicy(prefMap, projectId).mode !== "manual", logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
      await runBacklogEmptyStrategy(prefMap, { serverPort, boardEvents, allowProject: allowBacklogRefill, logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
    } catch (err) {
      console.warn("[monitor] Cycle error:", err);
    } finally {
      cycleRunning = false;
      monitorState.lastRun = { at: new Date().toISOString(), ...cycleStats, resources: resourceSummary, warnings: warningCount };
      const prefRows = await db.select().from(preferences).catch(() => []);
      const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
      if (monitorShouldRun(prefMap)) {
        const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
        monitorState.nextRunAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
        // Always clear the previous timer before re-arming: event-triggered runs call
        // runMonitorCycle directly (not via the timer), so without this the old periodic
        // timer would leak and accumulate, firing redundant cycles.
        if (monitorState.timer) clearTimeout(monitorState.timer);
        monitorState.timer = setTimeout(runMonitorCycle, intervalMin * 60 * 1000);
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
    await refreshMonitorWarnings(prefMap).catch((err) => console.warn("[monitor] Monitor warning health check failed:", err));
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
  const invalidationListener = () => triggerMonitorSoon();
  boardEvents.addInvalidationListener(invalidationListener);

  const syncMonitorInterval = setInterval(syncMonitorState, 30_000);
  syncMonitorInterval.unref?.();
  syncMonitorState().catch(() => {});
  const resourceSweepInterval = setInterval(() => void runStandaloneResourceSweep(), 5 * 60_000);
  resourceSweepInterval.unref?.();
  runStandaloneResourceSweep().catch(() => {});
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
