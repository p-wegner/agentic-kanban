import { workers, sessions, workspaces, issues } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type WorkerRow = typeof workers.$inferSelect;
export type NewWorkerRow = typeof workers.$inferInsert;

export async function insertWorker(row: NewWorkerRow, database: Database = db): Promise<void> {
  await database.insert(workers).values(row);
}

export async function getWorkerById(id: string, database: Database = db): Promise<WorkerRow | null> {
  const rows = await database.select().from(workers).where(eq(workers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listWorkers(database: Database = db): Promise<WorkerRow[]> {
  return database.select().from(workers).orderBy(workers.name);
}

export async function updateWorkerHeartbeat(
  id: string,
  at: string,
  status: string | undefined,
  database: Database = db,
): Promise<void> {
  await database.update(workers)
    .set({ lastHeartbeatAt: at, updatedAt: at, ...(status ? { status } : {}) })
    .where(eq(workers.id, id));
}

export async function updateWorkerStatus(
  id: string,
  status: string,
  at: string,
  database: Database = db,
): Promise<void> {
  await database.update(workers).set({ status, updatedAt: at }).where(eq(workers.id, id));
}

export async function deleteWorker(id: string, database: Database = db): Promise<void> {
  await database.delete(workers).where(eq(workers.id, id));
}

/**
 * The branches a project actually DISPATCHED to a fleet worker — the persisted
 * assignment record (`sessions.workerId` + the workspace's branch) that survives
 * a board restart. The incoming-ref sweep uses it to land only refs it asked a
 * worker to produce (#246): an incoming ref with no such assignment is held and
 * reported, never fast-forwarded onto `refs/heads/*`.
 */
export async function listWorkerAssignedBranches(
  projectId: string,
  database: Database = db,
): Promise<Set<string>> {
  const rows = await database
    .select({ branch: workspaces.branch })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(and(eq(issues.projectId, projectId), isNotNull(sessions.workerId)));
  return new Set(rows.map((r) => r.branch));
}

/**
 * Is this session still live on this worker, from the DB's point of view?
 *
 * Asked when a worker reconnects and announces a session the board process has no
 * memory of. The answer decides between two very different things: a zombie whose
 * board row was already finalized (stop it), and a session that is genuinely still
 * running and doing sanctioned work (leave it alone).
 *
 * Returns null when there is no such session row at all.
 */
export async function getSessionLiveness(
  sessionId: string,
  database: Database = db,
): Promise<{ status: string; workerId: string | null } | null> {
  const rows = await database
    .select({ status: sessions.status, workerId: sessions.workerId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  return row ? { status: row.status, workerId: row.workerId ?? null } : null;
}

/**
 * Stamp which fleet worker a session runs on (mirrors sessions.containerId).
 *
 * Delegates to the `sessions`-owning repository (#957) instead of writing the table
 * here — same rule `updateSessionContainerId` already follows. Re-exported from this
 * module so fleet callers keep importing it from the worker repository.
 */
export { updateSessionWorkerId } from "./session.repository.js";
