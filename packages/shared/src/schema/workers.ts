import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";
import { sessions } from "./sessions.js";

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
  // Migration-only until #812: created by 0130 alongside the FK it supports (#740's rule),
  // but never declared here — which is why #812 read this FK as unindexed.
  projectIdx: index("idx_worker_git_tokens_project_id").on(table.projectId),
}));

/**
 * Per-worker event timeline (#774, the first of #755's remaining items).
 *
 * The board kept NO history of what a worker did: a connect, a disconnect, an
 * assignment, a session exit and a held incoming ref all existed only as a
 * `console.*` line in the server's stdout (and the Windows daemon's `-Log`). So a
 * #699/#706-class failure — "the worker vanished mid-run and the session hung" — was
 * reconstructed from scrollback, which is gone after a restart. One row per event,
 * so the question "what happened to that worker, in order" has an answer that
 * survives a reboot.
 *
 * RETENTION — answered BEFORE the table landed, because an unbounded event log on a
 * busy fleet is #738 again (99,140 issue comments, 127 MB of a 186 MB database):
 * the repository caps rows PER WORKER (`WORKER_EVENT_RETENTION_LIMIT`, 300) and
 * prunes the oldest past the cap, so the table's ceiling is
 * `registered workers x 300` — a bound that does not depend on fleet traffic at all.
 * A revoked worker's rows are deleted with it (see below), so the bound shrinks when
 * the fleet does. Same shape as `board_health_events`, which caps per project.
 *
 * `worker_id` is deliberately FK-LESS, for the same reason `worker_git_tokens.worker_id`
 * is: revocation deletes these rows explicitly (`deleteWorkerEvents`, called from
 * `revokeWorker`'s hook), and an FK would make an event insert fail — silently, since
 * event writes are fire-and-forget so a diagnostic can never break a fleet operation —
 * whenever the worker row is written in the same turn (which is exactly what a
 * `registered` event does). `worker_id` is not in the parent-id name set the cascade
 * gate polices, so this is a design choice rather than a blessed exception.
 *
 * `session_id` DOES carry a cascading FK: an `assigned`/`session_exit` event is about a
 * session, and a row naming a session that no longer exists is a dangling reference the
 * panel would render as a dead link. That enrols this table in the issue-deletion
 * subtree gate, which is the point.
 *
 * There is deliberately NO `project_id` column. This is a per-WORKER timeline and most
 * of its rows (connect, disconnect, register) have no project at all; the project
 * dimension of the fleet is already served by `GET /api/workers/incoming` (#752). A
 * held-ref event carries its projectId inside `payload_json` instead, which keeps a
 * worker's connectivity history from being deleted by a project's lifetime.
 */
export const workerEvents = sqliteTable("worker_events", {
  id: text("id").primaryKey(),
  /** FK-less on purpose — see the table comment. */
  workerId: text("worker_id").notNull(),
  /** One of WORKER_EVENT_TYPES (worker-events.service.ts). Text, not an enum: SQLite has none. */
  type: text("type").notNull(),
  /** The session this event is about, when it is about one. Cascades: see the table comment. */
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  /** Human-readable one-liner — what the panel timeline renders. */
  summary: text("summary").notNull(),
  /** Optional JSON detail (projectId + branch for a held ref, exit code, error text). */
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // The panel's only query: this worker's events, newest first.
  workerIdx: index("idx_worker_events_worker_created").on(table.workerId, table.createdAt),
  // FK-supporting index (#740): without it the cascade check on a session delete is a scan.
  sessionIdx: index("idx_worker_events_session_id").on(table.sessionId),
}));
