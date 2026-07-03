/**
 * Shared libsql connection pragmas (#987).
 *
 * FK enforcement (and the WAL/perf settings) are PER CONNECTION in SQLite/libsql.
 * `db/index.ts` always applied them to the server's read/write connections, but
 * ad-hoc scripts (db-repair, one-off queries) created bare `createClient(...)`
 * clients with NO pragmas — those connections silently ran with `foreign_keys=OFF`
 * and could insert FK-violating rows into the live DB. This module is the single
 * pragma implementation: the server connections and every script client must go
 * through it.
 */
import { createClient } from "@libsql/client";

type LibsqlClient = ReturnType<typeof createClient>;

/** Apply the standard connection pragmas to an existing client. */
export async function applyPragmas(c: LibsqlClient): Promise<void> {
  // foreign_keys=ON: SQLite/libsql enforce FK constraints per connection.
  await c.execute("PRAGMA foreign_keys=ON");
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

/**
 * Create a libsql client with the standard pragmas already applied — the factory
 * scripts must use instead of a bare `createClient` (which leaves FK enforcement
 * OFF for the whole connection). Throws if the pragmas cannot be applied (e.g.
 * the file is not a valid SQLite database) — callers that must diagnose broken
 * DBs should catch and inspect the error code.
 */
export async function createClientWithPragmas(url: string): Promise<LibsqlClient> {
  const client = createClient({ url });
  try {
    await applyPragmas(client);
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}
