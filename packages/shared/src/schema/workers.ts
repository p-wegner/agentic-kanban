import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

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

/**
 * Persisted git-transport tokens for the worker fleet (#775).
 *
 * Only the sha-256 DIGEST is stored, never the token — same rule as `workers.tokenHash`.
 * The row is the SCOPE (#247): which worker, which project, which incoming ref, and the
 * TTL ceiling. Authority is still re-derived from `sessions` on every request (#753), so
 * this table can never widen what a token may do; it only stops the board FORGETTING a
 * token it issued.
 *
 * Why it has to survive a restart: the scope used to live solely in an in-memory
 * `createExpiringDigestStore`, so after a board restart a worker finishing its run pushed
 * with a token the board no longer knew and got a 401 it could not recover from. That is
 * what made #745's recovery promise partial — the board keeps the session and waits for the
 * worker's exit, but the worker could not deliver its push.
 *
 * Deliberately NO foreign key to `workers`: revocation deletes these rows explicitly
 * (`deleteGitTokensForWorker`, called from `revokeWorker`), and an FK would make a token
 * insert fail — silently, since the insert is fire-and-forget off a synchronous
 * `issueToken` — whenever the worker row is written in the same turn.
 */
export const workerGitTokens = sqliteTable("worker_git_tokens", {
  /** sha-256 hex of the clear token. The primary key: lookup is BY DIGEST, never by compare. */
  tokenHash: text("token_hash").primaryKey(),
  workerId: text("worker_id").notNull(),
  /**
   * Cascades: a git token is a CAPABILITY scoped to one project, not history — a row
   * outliving its project is an authorisation that outlives its subject. (No FK to
   * `workers`, deliberately: see the migration header. That argument does not apply
   * here, because a token is only ever issued for an already-committed project row.)
   */
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** The one ref a receive-pack under this token may update. NULL = read-only in practice. */
  incomingRef: text("incoming_ref"),
  /** Epoch ms — the clock the assignment-settle window is measured from. */
  issuedAtMs: integer("issued_at_ms").notNull(),
  /** Epoch ms ceiling. Not the bound that matters (see #753), but it bounds this table's growth. */
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => ({
  workerIdx: index("idx_worker_git_tokens_worker_id").on(table.workerId),
  expiresIdx: index("idx_worker_git_tokens_expires_at_ms").on(table.expiresAtMs),
}));
