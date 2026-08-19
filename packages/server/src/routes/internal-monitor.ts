import type { Hono } from "hono";
import { getBool, getNumber } from "@agentic-kanban/shared/lib/settings-registry";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { MonitorStatusResponse } from "@agentic-kanban/shared/types";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { conditionalJsonResponse } from "../services/board-etag-cache.service.js";
import type { BoardMonitorResourceSnapshot } from "../services/stale-dev-processes.js";
import { monitorDrivenProjectIds } from "../services/start-policy.service.js";
import type { MonitorState } from "../startup/monitor-setup.js";

/**
 * The `/api/internal/*` monitor endpoints (#595).
 *
 * These were defined inside `startup/monitor-setup.ts` — the only route definitions
 * anywhere outside `routes/`. That mattered beyond tidiness: `.dependency-cruiser.cjs`
 * enforces `routes → services → repositories → db` and `services-not-up-to-routes`, and
 * `startup/` sits outside every one of those rules, so three live HTTP handlers were
 * exempt from the layering the other ~47 routes obey.
 *
 * They stay `app.<verb>` rather than a `createRouter()` under a prefix, because their paths
 * are absolute `/api/internal/...` and the mount points are what external orchestrator
 * loops and the client's monitor popover already call. `setupMonitorRoutes` in
 * `monitor-setup.ts` is now a one-line delegation, so the WIRING (which owns `monitorState`
 * and the cycle runner) is unchanged and only the definitions moved.
 */

/** Default (non-verbose) monitor-status caps the resource snapshot's decision lists —
 *  the client renders at most 3 of each (`MonitorSections.tsx`). */
const RESOURCE_SNAPSHOT_ITEM_CAP = 5;

export function registerInternalMonitorRoutes(app: Hono, monitorState: MonitorState, runMonitorCycle: (force?: boolean) => Promise<void>, _syncMonitorState: () => Promise<void>, runResourceSweep?: (force?: boolean) => Promise<BoardMonitorResourceSnapshot | null>) {
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
    const prefRows = await getAllPreferencesCached();
    const prefMap = toPrefMap(prefRows);
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
    const payload: MonitorStatusResponse = {
      /** Will the monitor run on its own? (global toggle OR a monitor-mode project) */
      enabled: getBool(prefMap, "auto_monitor") || drivenProjectIds.size > 0,
      /** The raw `auto_monitor` pref — the state of the settings toggle, nothing more. */
      globalToggle: getBool(prefMap, "auto_monitor"),
      /** Projects whose resolved Start Mode makes them monitor-driven regardless of the toggle. */
      monitorDrivenProjectCount: drivenProjectIds.size,
      intervalMin: getNumber(prefMap, "auto_monitor_interval"),
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
