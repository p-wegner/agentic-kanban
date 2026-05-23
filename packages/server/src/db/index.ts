import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";

const DB_URL = process.env.DB_URL || "file:kanban.db";

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
} catch {
  // Non-fatal: pragmas may fail on read-only or in-memory DBs.
}

export const db = drizzle({ client, schema });
export { schema };

export type Database = ReturnType<typeof drizzle<typeof schema>>;
