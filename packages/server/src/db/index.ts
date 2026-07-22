import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { getDbUrl, ensureDataDir, DB_LOCATION } from "./data-dir.js";
// Single pragma implementation shared with script clients (db-repair etc., #987) —
// a bare createClient without these runs with foreign_keys=OFF for the connection.
import { applyPragmas } from "./pragmas.js";

ensureDataDir();
const DB_URL = getDbUrl();
// Log the resolved absolute DB path at startup so a split-brain (server and MCP
// opening different databases) is visible instead of silent (#962). Emit on STDERR,
// not stdout: this fires at import for the CLI too, and a stdout line corrupts
// `--json` output (e.g. `pnpm cli -- issue list --json | jq`). stderr keeps it
// visible without polluting machine-readable stdout.
console.error(`[db] opening ${DB_LOCATION.path ?? DB_URL} (source: ${DB_LOCATION.source})`);

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
  console.warn("[db] applyPragmas(read) failed:", err instanceof Error ? err.message : String(err));
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
  console.warn("[db] applyPragmas(write) failed:", err instanceof Error ? err.message : String(err));
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
): Promise<T> {
  return withDbRetry(() => database.transaction(fn), context);
}
