import { workers } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
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
 * Stamp which fleet worker a session runs on (mirrors sessions.containerId).
 *
 * Delegates to the `sessions`-owning repository (#957) instead of writing the table
 * here — same rule `updateSessionContainerId` already follows. Re-exported from this
 * module so fleet callers keep importing it from the worker repository.
 */
export { updateSessionWorkerId } from "./session-lifecycle.repository.js";
