import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";

// Resolve DB path: prefer env var, then monorepo dev DB, then ~/.agentic-kanban/.
// NOTE: the monorepo dev DB (../../server/kanban.db) must take precedence over the
// ~/.agentic-kanban fallback. Otherwise, when both exist, an MCP server spawned during
// monorepo development reads the stale published DB instead of the dev DB the main
// server uses — causing tools to report the wrong board (see butler #45 investigation).
// `import.meta.dirname` only resolves to a real dev path inside the monorepo, so this is
// a no-op for published installs (devPath won't exist → falls through to publishedPath).
function resolveDbPath(): string {
  if (process.env.DB_URL) return process.env.DB_URL;
  const dataDir = process.env.AGENTIC_KANBAN_DIR || join(homedir(), ".agentic-kanban");
  const publishedPath = resolve(dataDir, "kanban.db");
  // Monorepo dev: ../../server/kanban.db relative to this file — prefer it when present.
  const devPath = resolve(import.meta.dirname, "../../server/kanban.db");
  if (existsSync(devPath)) return devPath;
  // Published default: ~/.agentic-kanban/kanban.db
  if (existsSync(publishedPath)) return publishedPath;
  // Fallback: create ~/.agentic-kanban/ and use it
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return publishedPath;
}

const dbPath = resolveDbPath();
const url = dbPath.startsWith("file:") ? dbPath : `file:${dbPath}`;

async function applyPragmas(c: ReturnType<typeof createClient>) {
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

// Apply the same pragma discipline as the server DB entrypoint so MCP tools
// cannot bypass FK enforcement and tolerate normal server write contention.
const client = createClient({ url });
try {
  await applyPragmas(client);
} catch {
  // Non-fatal: pragmas may fail on read-only or in-memory DBs.
}

export const db = drizzle({ client, schema });
export const rawClient = client;
export { schema };
