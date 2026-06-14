import {
  DRIVE_OBSTACLE_KINDS,
  DRIVE_OBSTACLE_SEVERITIES,
} from "@agentic-kanban/shared/schema";
import type { DriveObstacleKind, DriveObstacleSeverity } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  logDriveObstacle,
  listDriveObstacles,
  summarizeDriveObstacles,
  type DriveObstacleRow,
  type DriveObstacleSummaryRow,
  type LogDriveObstacleInput,
} from "../repositories/drive-obstacle.repository.js";

/**
 * Structured drive-obstacle telemetry (#803).
 *
 * The single entry point for *detecting* drive friction. Any code that notices an obstacle —
 * the autodrive monitor (over-launch, premature cascade), the verify gate (verify-gate
 * failure), the silent-merge-loss reconcilers, the stall watchdog, scaffold detection —
 * calls `recordDriveObstacle()` instead of only logging to the console. The event is
 * persisted to the typed `drive_obstacles` stream (queryable + dashboard-feedable) and a
 * `drive_obstacle` board event is broadcast so live clients refresh.
 *
 * `recordDriveObstacle` is deliberately fire-and-forget-safe: it never throws back into the
 * caller's hot path. Telemetry must not be able to break the thing it observes — a failed
 * insert is swallowed and logged, returning null.
 */

/** Broadcaster injected by the caller (the board-events `broadcast`), kept optional so
 *  off-request callers — reconcilers, the monitor — can record without a live WS context. */
export type ObstacleBroadcaster = (projectId: string, reason: "drive_obstacle") => void;

export function isDriveObstacleKind(value: unknown): value is DriveObstacleKind {
  return typeof value === "string" && (DRIVE_OBSTACLE_KINDS as readonly string[]).includes(value);
}

export function isDriveObstacleSeverity(value: unknown): value is DriveObstacleSeverity {
  return typeof value === "string" && (DRIVE_OBSTACLE_SEVERITIES as readonly string[]).includes(value);
}

export interface RecordDriveObstacleOptions {
  database?: Database;
  /** Optional board broadcaster; when provided a `drive_obstacle` event is emitted on success. */
  broadcast?: ObstacleBroadcaster;
}

/**
 * Record one structured drive obstacle. Returns the new event id, or null if persistence
 * failed (never throws — telemetry must not break the driven flow). Broadcasts a
 * `drive_obstacle` board event when a broadcaster is supplied.
 */
export async function recordDriveObstacle(
  input: LogDriveObstacleInput,
  opts: RecordDriveObstacleOptions = {},
): Promise<string | null> {
  try {
    const id = await logDriveObstacle(input, opts.database ?? db);
    opts.broadcast?.(input.projectId, "drive_obstacle");
    return id;
  } catch (err) {
    console.error(
      `[drive-obstacles] failed to record ${input.kind} for project ${input.projectId}:`,
      err,
    );
    return null;
  }
}

export interface DriveObstacleService {
  record(input: LogDriveObstacleInput): Promise<string | null>;
  list(opts: {
    projectId: string;
    driveId?: string;
    kinds?: DriveObstacleKind[];
    severities?: DriveObstacleSeverity[];
    limit?: number;
  }): Promise<DriveObstacleRow[]>;
  summarize(opts: { projectId: string; driveId?: string }): Promise<DriveObstacleSummaryRow[]>;
}

/**
 * Construct a drive-obstacle service bound to a database and (optionally) a board broadcaster.
 * Routes pass the request's `boardEvents.broadcast`; off-request callers omit it.
 */
export function createDriveObstacleService(
  database: Database,
  broadcast?: ObstacleBroadcaster,
): DriveObstacleService {
  return {
    record: (input) => recordDriveObstacle(input, { database, broadcast }),
    list: (opts) => listDriveObstacles(opts, database),
    summarize: (opts) => summarizeDriveObstacles(opts, database),
  };
}
