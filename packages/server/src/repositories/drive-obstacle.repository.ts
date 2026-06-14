import { randomUUID } from "node:crypto";
import { driveObstacles } from "@agentic-kanban/shared/schema";
import type { DriveObstacleKind, DriveObstacleSeverity } from "@agentic-kanban/shared/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type DriveObstacleRow = typeof driveObstacles.$inferSelect;

/** Maximum obstacle rows retained per project before old ones are pruned. */
const RETENTION_LIMIT = 1000;

export interface LogDriveObstacleInput {
  projectId: string;
  /** The drive this obstacle occurred under, if any. */
  driveId?: string | null;
  kind: DriveObstacleKind;
  /** Defaults to "warning" when omitted. */
  severity?: DriveObstacleSeverity;
  /** Issue number this obstacle relates to, if applicable. */
  issueNumber?: number | null;
  summary: string;
  /** Optional structured context — serialized to JSON. */
  details?: unknown;
  /** Override the detection timestamp (tests / replay). */
  detectedAt?: string;
}

/**
 * Append one structured drive-obstacle event. Returns the generated id.
 * Fire-and-forgets a prune roughly every ~50 inserts to keep the table bounded.
 */
export async function logDriveObstacle(
  input: LogDriveObstacleInput,
  database: Database = db,
): Promise<string> {
  const id = randomUUID();
  await database.insert(driveObstacles).values({
    id,
    projectId: input.projectId,
    driveId: input.driveId ?? null,
    kind: input.kind,
    severity: input.severity ?? "warning",
    issueNumber: input.issueNumber ?? null,
    summary: input.summary,
    details: input.details === undefined ? null : JSON.stringify(input.details),
    detectedAt: input.detectedAt ?? new Date().toISOString(),
  });

  // Prune probabilistically to avoid per-row overhead.
  if (Math.random() < 0.02) {
    pruneOldDriveObstacles(input.projectId, database).catch(() => {});
  }

  return id;
}

/** Fetch a single drive obstacle by id, or null if not found. */
export async function getDriveObstacle(
  id: string,
  database: Database = db,
): Promise<DriveObstacleRow | null> {
  const rows = await database
    .select()
    .from(driveObstacles)
    .where(eq(driveObstacles.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Most-recent-first obstacles for a project, optionally filtered by kind(s), severity(ies),
 * or a specific drive, capped by limit. This is the queryable obstacle log.
 */
export async function listDriveObstacles(
  opts: {
    projectId: string;
    driveId?: string;
    kinds?: DriveObstacleKind[];
    severities?: DriveObstacleSeverity[];
    limit?: number;
  },
  database: Database = db,
): Promise<DriveObstacleRow[]> {
  const conditions = [eq(driveObstacles.projectId, opts.projectId)];
  if (opts.driveId) {
    conditions.push(eq(driveObstacles.driveId, opts.driveId));
  }
  if (opts.kinds && opts.kinds.length > 0) {
    conditions.push(inArray(driveObstacles.kind, opts.kinds));
  }
  if (opts.severities && opts.severities.length > 0) {
    conditions.push(inArray(driveObstacles.severity, opts.severities));
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  return database
    .select()
    .from(driveObstacles)
    .where(where)
    .orderBy(desc(driveObstacles.detectedAt))
    .limit(opts.limit ?? 100);
}

export interface DriveObstacleSummaryRow {
  kind: DriveObstacleKind;
  count: number;
}

/**
 * Per-kind obstacle counts for a project (optionally scoped to one drive). Feeds the drive
 * dashboard's friction breakdown — every taxonomy kind is represented, including zeroes.
 */
export async function summarizeDriveObstacles(
  opts: { projectId: string; driveId?: string },
  database: Database = db,
): Promise<DriveObstacleSummaryRow[]> {
  const conditions = [eq(driveObstacles.projectId, opts.projectId)];
  if (opts.driveId) {
    conditions.push(eq(driveObstacles.driveId, opts.driveId));
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const rows = await database
    .select({
      kind: driveObstacles.kind,
      count: sql<number>`count(*)`,
    })
    .from(driveObstacles)
    .where(where)
    .groupBy(driveObstacles.kind);
  return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
}

/**
 * Delete old obstacles for a project beyond the retention limit (keeps the most recent
 * RETENTION_LIMIT rows). Keeps the table bounded.
 */
export async function pruneOldDriveObstacles(
  projectId: string,
  database: Database = db,
): Promise<void> {
  const cutoff = await database
    .select({ detectedAt: driveObstacles.detectedAt })
    .from(driveObstacles)
    .where(eq(driveObstacles.projectId, projectId))
    .orderBy(desc(driveObstacles.detectedAt))
    .limit(1)
    .offset(RETENTION_LIMIT - 1);

  if (cutoff.length === 0) return;

  await database
    .delete(driveObstacles)
    .where(
      and(
        eq(driveObstacles.projectId, projectId),
        lt(driveObstacles.detectedAt, cutoff[0].detectedAt),
      ),
    );
}
