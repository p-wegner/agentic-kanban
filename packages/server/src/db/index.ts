import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { getDbUrl, ensureDataDir } from "./data-dir.js";

ensureDataDir();
const DB_URL = getDbUrl();

// Create the libsql client manually so we can apply performance pragmas before
// handing it to Drizzle. WAL mode allows concurrent reads without blocking writes,
// and busy_timeout lets the writer retry for up to 10 seconds instead of immediately
// throwing SQLITE_BUSY when another connection holds a lock.
const client = createClient({ url: DB_URL });
try {
  // journal_mode=WAL: multiple readers never block a writer; writer doesn't block readers.
  await client.execute("PRAGMA journal_mode=WAL");
  // busy_timeout: wait up to 10s for a locked DB before throwing SQLITE_BUSY.
  await client.execute("PRAGMA busy_timeout=10000");
  // synchronous=NORMAL: with WAL this is crash-safe (only an OS/power loss can drop the
  // last few committed txns, acceptable for a local single-user board) and removes an
  // fsync per commit — the dominant cost of the high-frequency session-message write
  // stream from many concurrent agents, which was serializing the board read on the
  // single connection (SQLITE_BUSY / multi-second board spikes).
  await client.execute("PRAGMA synchronous=NORMAL");
  // temp_store=MEMORY: keep transient B-trees (ORDER BY / GROUP BY in the board
  // aggregation) in RAM instead of spilling to disk.
  await client.execute("PRAGMA temp_store=MEMORY");
  // cache_size=-65536: 64MB page cache (negative = KiB) so the hot board/issue/workspace
  // pages stay resident.
  await client.execute("PRAGMA cache_size=-65536");
  // mmap_size=256MB: memory-map reads to cut syscall overhead on the read-heavy board path.
  await client.execute("PRAGMA mmap_size=268435456");
} catch {
  // Non-fatal: pragmas may fail on read-only or in-memory DBs.
}

export const db = drizzle({ client, schema });
export const rawClient = client;
export { schema };
export { withDbRetry } from "./retry.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;
