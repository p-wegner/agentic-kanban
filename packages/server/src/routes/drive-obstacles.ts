import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { driveObstacleBody } from "./drive-obstacle-body-schemas.js";
import {
  createDriveObstacleService,
  DRIVE_OBSTACLE_KINDS,
  DRIVE_OBSTACLE_SEVERITIES,
} from "../services/drive-obstacles.service.js";
import type { DriveObstacleKind, DriveObstacleSeverity } from "../services/drive-obstacles.service.js";
import type { BoardEventSink } from "../services/board-events.js";

import { queryInt } from "../middleware/query-params.js";
const VALID_KINDS = new Set<string>(DRIVE_OBSTACLE_KINDS);
const VALID_SEVERITIES = new Set<string>(DRIVE_OBSTACLE_SEVERITIES);

function parseKinds(raw: string | undefined): DriveObstacleKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((k) => k.trim()).filter((k) => VALID_KINDS.has(k));
  return kinds.length > 0 ? (kinds as DriveObstacleKind[]) : undefined;
}

function parseSeverities(raw: string | undefined): DriveObstacleSeverity[] | undefined {
  if (!raw) return undefined;
  const sevs = raw.split(",").map((s) => s.trim()).filter((s) => VALID_SEVERITIES.has(s));
  return sevs.length > 0 ? (sevs as DriveObstacleSeverity[]) : undefined;
}

interface DriveObstaclesRouteOptions {
  boardEvents?: BoardEventSink;
}

/**
 * Structured drive-obstacle telemetry routes (#803). Mounted under `/projects`.
 *
 * - GET  /api/projects/:projectId/drive-obstacles            — queryable obstacle log
 *        (filter by `kind`, `severity`, `driveId`; `limit`). Most-recent-first.
 * - GET  /api/projects/:projectId/drive-obstacles/summary    — per-kind counts for the
 *        drive dashboard's friction breakdown (every taxonomy kind, zeroes included).
 * - POST /api/projects/:projectId/drive-obstacles            — record one obstacle. Used
 *        by detectors that run inside a request; broadcasts a `drive_obstacle` event.
 */
export function createDriveObstaclesRoute(
  database: Database,
  options: DriveObstaclesRouteOptions = {},
) {
  const router = createRouter();
  const service = createDriveObstacleService(database, options.boardEvents?.broadcast);

  // GET /api/projects/:projectId/drive-obstacles — queryable log
  router.get("/:projectId/drive-obstacles", async (c) => {
    const projectId = c.req.param("projectId");
    const obstacles = await service.list({
      projectId,
      driveId: c.req.query("driveId") || undefined,
      kinds: parseKinds(c.req.query("kind")),
      severities: parseSeverities(c.req.query("severity")),
      limit: queryInt(c, "limit", { def: 100, min: 1, max: 500 }),
    });
    return c.json(obstacles.map((o) => ({
      id: o.id,
      driveId: o.driveId,
      kind: o.kind,
      severity: o.severity,
      issueNumber: o.issueNumber,
      summary: o.summary,
      details: o.details,
      detectedAt: o.detectedAt,
    })));
  });

  // GET /api/projects/:projectId/drive-obstacles/summary — per-kind breakdown for the dashboard
  router.get("/:projectId/drive-obstacles/summary", async (c) => {
    const projectId = c.req.param("projectId");
    const driveId = c.req.query("driveId") || undefined;
    const rows = await service.summarize({ projectId, driveId });
    const counts = new Map(rows.map((r) => [r.kind, r.count]));
    // Represent every taxonomy kind so the dashboard renders a stable, zero-filled breakdown.
    const byKind = DRIVE_OBSTACLE_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
    const total = byKind.reduce((sum, k) => sum + k.count, 0);
    return c.json({ total, byKind });
  });

  // POST /api/projects/:projectId/drive-obstacles — record one obstacle
  router.post("/:projectId/drive-obstacles", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await parseJsonBody(c, driveObstacleBody);

    const id = await service.record({
      projectId,
      driveId: body.driveId ?? null,
      kind: body.kind,
      severity: body.severity,
      issueNumber: body.issueNumber ?? null,
      // `driveObstacleBody` already trims, exactly as the old `body.summary.trim()` did.
      summary: body.summary,
      details: body.details,
    });
    if (id === null) {
      return c.json({ error: "failed to record obstacle" }, 500);
    }
    return c.json({ id }, 201);
  });

  return router;
}
