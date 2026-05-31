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

export interface MonitorState {
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: string | null;
  lastRun: { at: string; relaunched: number; merged: number; nudged: number; resources: MonitorResourceSummary | null } | null;
  currentIntervalMin: number | null;
  recentActions: MonitorAction[];
  lastResourceSnapshot: BoardMonitorResourceSnapshot | null;
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

export function setupMonitorRoutes(app: Hono, monitorState: MonitorState, runMonitorCycle: (force?: boolean) => Promise<void>, _syncMonitorState: () => Promise<void>) {
  app.post("/api/internal/monitor-run", async (c) => {
    if (monitorState.timer) clearTimeout(monitorState.timer);
    monitorState.timer = setTimeout(() => {}, 0);
    monitorState.nextRunAt = null;
    runMonitorCycle(true).catch(() => {});
    return c.json({ triggered: true });
  });
  app.get("/api/internal/monitor-status", async (c) => {
    const prefRows = await db.select().from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    return c.json({ enabled: prefMap.get("auto_monitor") === "true", intervalMin: parseInt(prefMap.get("auto_monitor_interval") || "4", 10), active: monitorState.timer !== null, lastRun: monitorState.lastRun, nextRunAt: monitorState.nextRunAt, recentActions: monitorState.recentActions, resourceSnapshot: monitorState.lastResourceSnapshot });
  });
}

export function createMonitorSetup({ sessionManager, boardEvents, serverPort }: MonitorSetupDeps) {
  const monitorState: MonitorState = { timer: null, nextRunAt: null, lastRun: null, currentIntervalMin: null, recentActions: [], lastResourceSnapshot: null };
  async function runMonitorCycle(force = false) {
    const cycleStats = { relaunched: 0, merged: 0, nudged: 0 };
    let resourceSummary: MonitorResourceSummary | null = null;
    try {
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
      if (!force && prefMap.get("auto_monitor") !== "true") return;
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
      const candidates = await db.select({ wsId: workspaces.id, wsStatus: workspaces.status, workingDir: workspaces.workingDir, isDirect: workspaces.isDirect, projectId: issues.projectId, issueId: issues.id, issueTitle: issues.title, issueNumber: issues.issueNumber, issueStatusName: projectStatuses.name, baseBranch: workspaces.baseBranch, readyForMerge: workspaces.readyForMerge }).from(workspaces)
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
        autoMergeEnabled: prefMap.get("auto_merge") === "true",
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
      monitorState.lastRun = { at: new Date().toISOString(), ...cycleStats, resources: resourceSummary };
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

  setInterval(syncMonitorState, 30_000);
  syncMonitorState().catch(() => {});
  return { setupMonitorRoutes: (app: Hono) => setupMonitorRoutes(app, monitorState, runMonitorCycle, syncMonitorState), monitorState };
}
