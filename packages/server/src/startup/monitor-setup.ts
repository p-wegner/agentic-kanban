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
import { scanDirtyMainCheckouts, type DirtyMainCheckoutWarning } from "../services/dirty-main-checkout.js";
import { resolveMergeStrategy } from "./merge-strategy.js";

export interface MonitorState {
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: string | null;
  lastRun: { at: string; relaunched: number; merged: number; nudged: number; resources: MonitorResourceSummary | null; warnings: number } | null;
  currentIntervalMin: number | null;
  recentActions: MonitorAction[];
  lastResourceSnapshot: BoardMonitorResourceSnapshot | null;
  warnings: DirtyMainCheckoutWarning[];
  lastHealthCheckAt: string | null;
}

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

export function createMonitorSetup({ sessionManager, boardEvents, serverPort }: MonitorSetupDeps) {
  const monitorState: MonitorState = { timer: null, nextRunAt: null, lastRun: null, currentIntervalMin: null, recentActions: [], lastResourceSnapshot: null, warnings: [], lastHealthCheckAt: null };
  let lastWarningFingerprint = "";
  async function refreshDirtyMainCheckoutWarnings() {
    const warnings = await scanDirtyMainCheckouts(db);
    monitorState.warnings = warnings;
    monitorState.lastHealthCheckAt = new Date().toISOString();
    const warningFingerprint = warnings
      .map((warning) => `${warning.projectId}:${warning.files.join("|")}`)
      .join(";");
    if (warningFingerprint && warningFingerprint !== lastWarningFingerprint) {
      for (const warning of warnings) {
        console.warn(`[monitor] ${warning.message} (${warning.repoPath})`);
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
    const cycleStats = { relaunched: 0, merged: 0, nudged: 0 };
    let resourceSummary: MonitorResourceSummary | null = null;
    let warningCount = monitorState.warnings.length;
    try {
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
      if (!force && prefMap.get("auto_monitor") !== "true") return;
      if (isInMaintenanceWindow(prefMap)) {
        warningCount = (await refreshDirtyMainCheckoutWarnings()).length;
        const endTime = prefMap.get("monitor_maintenance_window_end");
        console.log(`[monitor] Maintenance window active — skipping disruptive actions${endTime ? ` until ${endTime}` : ""}`);
        return;
      }
      const mergeStrategy = resolveMergeStrategy(prefMap);
      warningCount = (await refreshDirtyMainCheckoutWarnings()).length;
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
      Object.assign(cycleStats, await processWorkspaceCandidates(candidates, {
        sessionManager,
        boardEvents,
        serverPort,
        autoMergeEnabled: prefMap.get("auto_merge") === "true" && mergeStrategy === "monitor",
        autoMergeInReview: prefMap.get("auto_merge_in_review") === "true",
        monitorRecentActions: monitorState.recentActions,
        logMonitorAction,
        buildMonitorNudgePrompt,
        getRecentAgentExcerpts,
        shouldSkipNudge,
      }));
      await runAutoStart(prefMap, { serverPort, boardEvents, logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
      await runBacklogEmptyStrategy(prefMap, { serverPort, boardEvents, logMonitorAction: (action, workspaceId, issueId) => logMonitorAction(monitorState.recentActions, action, workspaceId, issueId) });
    } catch (err) {
      console.warn("[monitor] Cycle error:", err);
    } finally {
      monitorState.lastRun = { at: new Date().toISOString(), ...cycleStats, resources: resourceSummary, warnings: warningCount };
      const prefRows = await db.select().from(preferences).catch(() => []);
      const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
      if (prefMap.get("auto_monitor") === "true") {
        const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
        monitorState.nextRunAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
        monitorState.timer = setTimeout(runMonitorCycle, intervalMin * 60 * 1000);
      } else {
        monitorState.nextRunAt = null;
      }
    }
  }

  async function syncMonitorState() {
    await refreshDirtyMainCheckoutWarnings().catch((err) => console.warn("[monitor] Dirty main-checkout health check failed:", err));
    const prefRows = await db.select().from(preferences).catch(() => []);
    const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
    const enabled = prefMap.get("auto_monitor") === "true";
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
        if (prefMap.get("auto_monitor") === "true") return null;
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

  setInterval(syncMonitorState, 30_000);
  syncMonitorState().catch(() => {});
  setInterval(() => void runStandaloneResourceSweep(), 5 * 60_000);
  runStandaloneResourceSweep().catch(() => {});
  return {
    setupMonitorRoutes: (app: Hono) => setupMonitorRoutes(app, monitorState, runMonitorCycle, syncMonitorState, runStandaloneResourceSweep),
    monitorState,
  };
}
