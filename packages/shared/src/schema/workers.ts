import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Connected worker machines for the worker-fleet compute model (epic #1).
 * Workers register via a pairing token (POST /api/workers/register) and then
 * authenticate every call with their per-worker bearer token, stored here only
 * as a sha-256 hash. `status` is the stored intent (online/draining); the
 * EFFECTIVE status additionally derives from heartbeat age at read time, so a
 * dead worker reads offline without anyone writing a row.
 */
export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  os: text("os"),
  arch: text("arch"),
  /** JSON array of capability labels, e.g. ["docker","windows"]. */
  labels: text("labels"),
  /** JSON array of agent providers available on the worker, e.g. ["claude","codex"]. */
  providers: text("providers"),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  status: text("status").notNull().default("online"),
  tokenHash: text("token_hash").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  statusIdx: index("idx_workers_status").on(table.status),
}));
