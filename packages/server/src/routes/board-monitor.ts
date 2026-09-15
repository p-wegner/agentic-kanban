import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getAllPreferences, getPreference, setPreference } from "../repositories/preferences.repository.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { resolveWipLimit } from "../services/wip-limit.service.js";
import { resolveProjectRuntimeConfig } from "../services/project-runtime-config.service.js";
import { conductorAvailable, startConductor, stopConductor } from "../services/conductor-control.service.js";
import {
  conductorCronPrefKey,
  parseConductorSchedule,
  resolveConductorSchedule,
  serializeConductorSchedule,
  type ConductorSchedule,
} from "../services/conductor-schedule.service.js";
import { validateCronExpression } from "@agentic-kanban/shared/lib/cron-utils";
import { deriveCapacityHold, readDiskHealthEvents, resolveMachineCapacity } from "@agentic-kanban/shared/lib/machine-capacity";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { requireProject } from "../services/require-project.js";
import { previewNextStartCandidates } from "../services/start-score-preview.service.js";
import { getAutopilotStatus, type AutopilotStatusDeps } from "../services/autopilot-status.service.js";
import { getDeliveryStatus } from "../services/delivery-status.service.js";

/**
 * #1102: the Autopilot chip re-reads on board events, and a Tier-1 capacity read spawns a
 * process — so `/autopilot` shares one read for a few seconds.
 */
const AUTOPILOT_CAPACITY_TTL_MS = 5_000;

function memoizeRecent<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { readAtMs: number; value: Promise<T> } | null = null;
  return () => {
    const readAtMs = Date.now();
    if (!cached || readAtMs - cached.readAtMs > ttlMs) {
      const value = read().catch((err: unknown) => { cached = null; throw err; });
      cached = { readAtMs, value };
    }
    return cached.value;
  };
}
/**
 * Read-only observability for the detached board-monitor orchestrator loop
 * (scripts/board-monitor/). Mounted under /projects.
 *
 * GET /api/projects/:id/orchestrator → OrchestratorStatus for that project's repo.
 * Returns `available: false` for any repo without scripts/board-monitor/loop.sh,
 * so the UI strip stays hidden for normal installs (which use the in-process monitor).
 *
 * GET /api/projects/:id/monitor-tunables → the resolved effective tunables with source.
 * Lets the UI show which control surface (Strategy Bullseye vs the legacy default) is driving
 * the in-process monitor.
 * Since #1029 it also carries `capacity` — the LIVE machine-capacity verdict projected
 * through `deriveCapacityHold` — because this payload is what the out-of-process Conductor
 * reads once per cycle before any start (the generated CAPACITY HOLD section of its
 * objective.md points here). The in-process monitor clamps to the same snapshot
 * (`clampWipToHeadroom`); this is the Conductor's copy of that brake.
 *
 * `deps.readMachineCapacity` is injectable so a test can hand the route a saturated
 * snapshot without a `fleet` binary or a tight box; production wires the real probe.
 */
export function createBoardMonitorRoute(
  database: Database,
  deps: {
    readMachineCapacity?: typeof resolveMachineCapacity;
    readDiskHealth?: typeof readDiskHealthEvents;
  } & Omit<AutopilotStatusDeps, "database" | "readMachineCapacity"> = {},
) {
  const router = createRouter();
  const readMachineCapacity = deps.readMachineCapacity ?? resolveMachineCapacity;
  const readDiskHealth = deps.readDiskHealth ?? readDiskHealthEvents;
  const readCapacityForAutopilot = memoizeRecent(() => readMachineCapacity(), AUTOPILOT_CAPACITY_TTL_MS);

  router.get("/:id/orchestrator", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) {
      return c.json({ available: false, error: "project not found" }, 404);
    }
    return c.json(readOrchestratorStatus(project.repoPath));
  });

  router.get("/:id/monitor-tunables", async (c) => {
    const projectId = c.req.param("id");
    await requireProject(projectId, database);
    const rows = await getAllPreferences(database);
    const prefMap = toPrefMap(rows);
    const resolved = resolveMonitorTunables(prefMap, projectId);
    // The WIP target through THE resolver (#919), like the monitor loops that act on it. Since
    // #1102 the Bullseye is the only stored answer, so `source` alone says where it came from.
    const wip = resolveWipLimit(prefMap, projectId);
    const tunables = { ...resolved.tunables, activeAgentsTarget: wip.limit };
    const runtime = resolveProjectRuntimeConfig({ projectId, prefMap });
    const capacity = deriveCapacityHold(await readMachineCapacity(), { maxNewStartsPerCycle: tunables.maxNewStartsPerCycle });
    // #1127: same cheap, fail-open shape as `capacity` above — `null` when the host isn't
    // Windows or the event log can't be read, never a thrown error and never a false alarm.
    const diskHealth = await readDiskHealth().catch(() => null);
    return c.json({ tunables, source: resolved.source, startPolicy: runtime.startPolicy, capacity, diskHealth });
  });

  // #1102: one glance for the toolbar Autopilot chip — Start Mode, running vs. limit, how many
  // tickets the NEXT cycle starts (through the monitor's own `decideStartSlots`), the hold that
  // stops it, and the effective auto-merge answer. Read-only.
  router.get("/:id/autopilot", async (c) => {
    const projectId = c.req.param("id");
    const status = await getAutopilotStatus(projectId, {
      database,
      readMachineCapacity: readCapacityForAutopilot,
      canDispatch: deps.canDispatch,
      hasFleetOverflowCapacity: deps.hasFleetOverflowCapacity,
      quiesceHostHeld: deps.quiesceHostHeld,
      nextCycleAt: deps.nextCycleAt,
    });
    return c.json(status);
  });

  // #1155: one glance for the header chip — the EFFECTIVE risk posture plus the EFFECTIVE
  // merge-train numbers, both server-resolved. Read-only; the panel behind it (#1156) writes
  // through the existing `PUT /api/preferences/settings` chokepoint, not this route.
  router.get("/:id/delivery", async (c) => {
    const projectId = c.req.param("id");
    const status = await getDeliveryStatus(projectId, database);
    return c.json(status);
  });

  // #917: top-N ranked Todo-pull candidates for this project, by the same score the
  // pull loop actually uses — makes the FIFO-replacement decision explainable in the
  // Monitor view instead of a number nobody can audit. Read-only: never persists a score.
  router.get("/:id/board-monitor/next", async (c) => {
    const projectId = c.req.param("id");
    await requireProject(projectId, database);
    const rows = await getAllPreferences(database);
    const prefMap = toPrefMap(rows);
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 10;
    const candidates = await previewNextStartCandidates(projectId, prefMap, limit, database);
    return c.json({ projectId, candidates });
  });

  // Start/stop the out-of-process Conductor loop (dogfood board only). The Start Mode UI
  // calls this when the user picks "conductor" (start) vs manual/monitor (stop).
  router.post("/:id/conductor", async (c) => {
    const projectId = c.req.param("id");
    const project = await requireProject(projectId, database);
    const body = await c.req
      .json<{ action?: "start" | "stop"; agent?: "claude" | "codex" }>()
      .catch((): { action?: "start" | "stop"; agent?: "claude" | "codex" } => ({}));
    const repoPath = project.repoPath || "";
    if (body.action === "start") {
      const result = startConductor(repoPath, body.agent === "codex" ? "codex" : "claude");
      return c.json({ ...result, status: readOrchestratorStatus(repoPath) }, result.ok ? 200 : 409);
    }
    if (body.action === "stop") {
      const result = stopConductor(repoPath);
      return c.json({ ...result, status: readOrchestratorStatus(repoPath) });
    }
    return c.json({ error: "action must be 'start' or 'stop'" }, 400);
  });

  // Cron schedule for the off-process Conductor (ticket #841). The continuous loop above
  // is always-on; this drives one off-process cycle per scheduled tick instead. Config is a
  // single per-project JSON preference; the minute scheduler (scheduled-tasks.ts) fires it.
  router.get("/:id/conductor-schedule", async (c) => {
    const projectId = c.req.param("id");
    const project = await requireProject(projectId, database);
    const raw = await getPreference(conductorCronPrefKey(projectId), database);
    return c.json({ available: conductorAvailable(project.repoPath || ""), schedule: resolveConductorSchedule(raw) });
  });

  router.put("/:id/conductor-schedule", async (c) => {
    const projectId = c.req.param("id");
    const project = await requireProject(projectId, database);
    const body = await c.req
      .json<{ enabled?: boolean; cron?: string; agent?: "claude" | "codex" }>()
      .catch(() => ({} as { enabled?: boolean; cron?: string; agent?: "claude" | "codex" }));

    const current = parseConductorSchedule(await getPreference(conductorCronPrefKey(projectId), database));
    const next: ConductorSchedule = {
      enabled: body.enabled ?? current.enabled,
      cron: body.cron !== undefined ? body.cron.trim() : current.cron,
      agent: body.agent === "codex" || body.agent === "claude" ? body.agent : current.agent,
      lastFiredAt: current.lastFiredAt, // server-owned; never overwritten by the UI
    };

    if (next.enabled && !next.cron) {
      return c.json({ error: "a cron expression is required to enable the schedule" }, 400);
    }
    if (next.cron) {
      const v = validateCronExpression(next.cron);
      if (!v.valid) return c.json({ error: v.error ?? "invalid cron expression" }, 400);
    }

    const serialized = serializeConductorSchedule(next);
    await setPreference(conductorCronPrefKey(projectId), serialized, database);
    return c.json({ available: conductorAvailable(project.repoPath || ""), schedule: resolveConductorSchedule(serialized) });
  });

  return router;
}
