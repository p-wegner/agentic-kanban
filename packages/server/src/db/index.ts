import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { getDbUrl, ensureDataDir, DB_LOCATION } from "./data-dir.js";
// Single pragma implementation shared with script clients (db-repair etc., #987) —
// a bare createClient without these runs with foreign_keys=OFF for the connection.
import { applyPragmas } from "./pragmas.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

ensureDataDir();
const DB_URL = getDbUrl();
// Log the resolved absolute DB path at startup so a split-brain (server and MCP
// opening different databases) is visible instead of silent (#962). Emit on STDERR,
// not stdout: this fires at import for the CLI too, and a stdout line corrupts
// `--json` output (e.g. `pnpm cli -- issue list --json | jq`). stderr keeps it
// visible without polluting machine-readable stdout.
console.error(`[db] opening ${DB_LOCATION.path ?? DB_URL} (source: ${DB_LOCATION.source})`);
// A checkout candidate that exists but was rejected as a stub is never harmless: it is a
// schema-only DB some tool minted in the checkout, and it is ONE size-floor bump away from
// silently shadowing the real database. Name it so the operator can delete it.
for (const rejected of DB_LOCATION.rejectedLocalCandidates) {
  console.warn(`[db] IGNORING ${rejected} — it exists but is too small to be a real database (a stray schema-only stub). Delete it; while it is there, any tool that resolves the DB differently will read an EMPTY board.`);
}

// Read connection — used for board/API queries. With WAL, readers proceed against the
// last checkpoint while the write connection commits, so board reads no longer queue
// behind the high-frequency session-message write stream.
const client = createClient({ url: DB_URL });
try {
  await applyPragmas(client);
} catch (err) {
  // Pragmas may legitimately fail on read-only or in-memory DBs, so this is not a
  // module-load crash — but it must NOT be silent: a failed `PRAGMA foreign_keys=ON`
  // leaves every ON DELETE clause inert. `assertForeignKeysEnabled` in startup-tasks
  // re-checks and fails loud; log here so the cause is visible even before that.
  console.warn("[db] applyPragmas(read) failed:", errorMessage(err));
}

// Write connection — dedicated to the high-volume session-message write stream and
// other mutations. Separate from the read connection so WAL's reader/writer isolation
// actually takes effect: a board aggregation query on `client` runs concurrently with
// a session-message batch insert on `writeClient`.
const writeClient = createClient({ url: DB_URL });
try {
  await applyPragmas(writeClient);
} catch (err) {
  // See the read connection above: not a crash, but never silent.
  console.warn("[db] applyPragmas(write) failed:", errorMessage(err));
}

export const db = drizzle({ client, schema });
export const writeDb = drizzle({ client: writeClient, schema });
export const rawClient = client;
export const rawWriteClient = writeClient;
export { schema };
import { withDbRetry } from "./retry.js";
export { withDbRetry };

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/** The transaction handle drizzle passes to a `db.transaction(fn)` callback. */
export type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run `fn` inside a single atomic transaction WITH SQLITE_BUSY retry. Makes
 * "multi-write or nothing" the easy default: every statement on the supplied `tx`
 * commits together or rolls back, and the whole transaction is retried on
 * contention via withDbRetry. Prefer this over a bare `database.transaction(...)`
 * for any operation that does more than one dependent write.
 */
export async function withTransaction<T>(
  database: Database,
  fn: (tx: TransactionClient) => Promise<T>,
  context = "transaction",
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withDbRetry(() => runWatchedTransaction(database, fn, context, opts.timeoutMs ?? TX_WATCHDOG_MS), context);
}

/**
 * #1487 — a transaction open longer than this is reported and failed. Healthy transactions here
 * are a handful of statements (milliseconds); the incident was one that sat for 35+ minutes with
 * no SQLITE_BUSY, no retry line and no timeout, wedging the create and its provisioning claim.
 */
export const TX_WATCHDOG_MS = 60_000;

/** Thrown to the caller of a transaction that exceeded its watchdog. Not retried by withDbRetry. */
export class TransactionTimeoutError extends Error {
  readonly code = "TX_TIMEOUT";
  constructor(readonly context: string, readonly timeoutMs: number) {
    super(`[db-tx-watchdog] transaction "${context}" was open longer than ${Math.round(timeoutMs / 1000)}s and was failed`);
    this.name = "TransactionTimeoutError";
  }
}

const openTransactions = new Map<number, { context: string; startedAtMs: number }>();
let transactionSeq = 0;

/** Diagnostics: the transactions currently open, oldest first, with their context labels. */
export function listOpenTransactions(nowMs: number = Date.now()): Array<{ context: string; ageMs: number }> {
  return [...openTransactions.values()]
    .map((t) => ({ context: t.context, ageMs: nowMs - t.startedAtMs }))
    .sort((a, b) => b.ageMs - a.ageMs);
}

async function runWatchedTransaction<T>(
  database: Database,
  fn: (tx: TransactionClient) => Promise<T>,
  context: string,
  timeoutMs: number,
): Promise<T> {
  const seq = ++transactionSeq;
  openTransactions.set(seq, { context, startedAtMs: Date.now() });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = database.transaction(async (tx) => {
    const result = await fn(tx);
    // A transaction that unblocks AFTER its caller was told it failed must not commit: throwing
    // here rolls it back, so a "failed" create never leaves a workspace row behind.
    if (timedOut) throw new TransactionTimeoutError(context, timeoutMs);
    return result;
  });
  // The race loser's rejection must not surface as an unhandled rejection.
  work.catch(() => {});
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const open = listOpenTransactions().map((t) => `${t.context}(${Math.round(t.ageMs / 1000)}s)`).join(", ");
      console.error(`[db-tx-watchdog] transaction "${context}" open > ${Math.round(timeoutMs / 1000)}s — failing it. Open transactions: ${open}`);
      reject(new TransactionTimeoutError(context, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    clearTimeout(timer);
    openTransactions.delete(seq);
  }
}
