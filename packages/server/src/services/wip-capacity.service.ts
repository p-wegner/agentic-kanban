import { issues, workspaces } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { db } from "../db/index.js";

/**
 * How much agent capacity is currently occupied (#594).
 *
 * Extracted from `startup/monitor-auto-start.ts`, which is a 579-line orchestrator importing
 * six services and the global `db`. `services/plugin-loop-start.service.ts` needed exactly
 * these ~40 lines and had to import UP into `startup/` to get them — the last of the five
 * `server-service → server-monitor` rule violations, and the only one that could not be
 * fixed by relocating a pure utility, because the code is a real query.
 *
 * Direction matters, not tidiness: `startup/` composes and drives `services/`, so a service
 * reaching back up means the two can only ever be loaded together. Auto-start's WIP question
 * is a service-level policy question that the monitor happens to be the loudest caller of.
 */

/** Issues carrying this tag are an explicit opt-out of monitor auto-start. */
export const SKIP_AUTO_START_TAG = "no-auto-start";

/**
 * Workspace statuses that occupy ACTIVE agent capacity.
 *
 * The old `status != 'closed'` check over-counted launch FAILURES: a provider usage-limit
 * launch lands the workspace in `blocked`, and a zero-output launch failure lands it in
 * `idle` — neither has a live agent, yet both held WIP indefinitely, so the board looked
 * full while nothing was working (#690). Counting only active statuses frees that capacity.
 */
export const AUTO_START_WIP_STATUSES = ["active", "reviewing", "fixing"] as const;

export const activeWipPredicate = sql`${workspaces.status} IN (${sql.join(
  AUTO_START_WIP_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

export interface WipCapacitySnapshot {
  /** The only value that consumes WIP slots. */
  active: number;
  /**
   * Lingering idle/closed/merged rows, reported separately so they stay VISIBLE without
   * blocking the next unblocked ticket — the #690 failure was exactly this being conflated.
   */
  inactiveStale: number;
}

/** Capacity diagnostics for the auto-start gate. */
export async function countWipCapacity(
  database: Pick<typeof db, "select">,
  inProgressStatusId: string,
): Promise<WipCapacitySnapshot> {
  const rows = await database.select({
    active: sql<number>`count(distinct CASE WHEN ${activeWipPredicate} THEN ${issues.id} END)`,
    inactiveStale: sql<number>`count(distinct CASE WHEN NOT (${activeWipPredicate}) THEN ${workspaces.id} END)`,
  }).from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(sql`${issues.statusId} = ${inProgressStatusId}`);
  const legacyCount = (rows[0] as { count?: number } | undefined)?.count;
  return {
    active: Number(rows[0]?.active ?? legacyCount ?? 0),
    inactiveStale: Number(rows[0]?.inactiveStale ?? 0),
  };
}

/**
 * Distinct In-Progress issues whose workspace is ACTIVELY running an agent — the real WIP
 * for auto-start decisions.
 *
 * Database-injectable so the #690 regression can prove that a usage-limit `blocked`
 * workspace and a zero-output `idle` launch failure do NOT inflate the count.
 */
export async function countActiveWip(
  database: Pick<typeof db, "select">,
  inProgressStatusId: string,
): Promise<number> {
  return (await countWipCapacity(database, inProgressStatusId)).active;
}
