import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { getDbUrl, ensureDataDir } from "./data-dir.js";

ensureDataDir();
const DB_URL = getDbUrl();

async function applyPragmas(c: ReturnType<typeof createClient>) {
  // journal_mode=WAL: multiple readers never block a writer; writer doesn't block readers.
  await c.execute("PRAGMA journal_mode=WAL");
  // busy_timeout: wait up to 10s for a locked DB before throwing SQLITE_BUSY.
  await c.execute("PRAGMA busy_timeout=10000");
  // synchronous=NORMAL: crash-safe with WAL; removes an fsync per commit.
  await c.execute("PRAGMA synchronous=NORMAL");
  // temp_store=MEMORY: keep transient B-trees in RAM.
  await c.execute("PRAGMA temp_store=MEMORY");
  // cache_size=-65536: 64MB page cache.
  await c.execute("PRAGMA cache_size=-65536");
  // mmap_size=256MB: memory-map reads to cut syscall overhead.
  await c.execute("PRAGMA mmap_size=268435456");
}

// Read connection — used for board/API queries. With WAL, readers proceed against the
// last checkpoint while the write connection commits, so board reads no longer queue
// behind the high-frequency session-message write stream.
const client = createClient({ url: DB_URL });
try {
  await applyPragmas(client);
} catch {
  // Non-fatal: pragmas may fail on read-only or in-memory DBs.
}

// Write connection — dedicated to the high-volume session-message write stream and
// other mutations. Separate from the read connection so WAL's reader/writer isolation
// actually takes effect: a board aggregation query on `client` runs concurrently with
// a session-message batch insert on `writeClient`.
const writeClient = createClient({ url: DB_URL });
try {
  await applyPragmas(writeClient);
} catch {
  // Non-fatal.
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
