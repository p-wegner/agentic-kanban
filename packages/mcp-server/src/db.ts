import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { assertForeignKeysEnabled } from "@agentic-kanban/shared/lib/fk-assert";

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

const PRAGMAS: ReadonlyArray<readonly [pragma: string, rationale: string]> = [
  // foreign_keys=ON: SQLite/libsql enforce FK constraints per connection.
  ["PRAGMA foreign_keys=ON", "FK enforcement (per connection)"],
  // journal_mode=WAL: multiple readers never block a writer; writer doesn't block readers.
  ["PRAGMA journal_mode=WAL", "WAL journal mode"],
  // busy_timeout: wait up to 10s for a locked DB before throwing SQLITE_BUSY.
  ["PRAGMA busy_timeout=10000", "busy timeout"],
  // synchronous=NORMAL: crash-safe with WAL; removes an fsync per commit.
  ["PRAGMA synchronous=NORMAL", "synchronous=NORMAL"],
  // temp_store=MEMORY: keep transient B-trees in RAM.
  ["PRAGMA temp_store=MEMORY", "temp_store=MEMORY"],
  // cache_size=-65536: 64MB page cache.
  ["PRAGMA cache_size=-65536", "page cache size"],
  // mmap_size=256MB: memory-map reads to cut syscall overhead.
  ["PRAGMA mmap_size=268435456", "mmap size"],
];

// Apply each pragma individually and LOG which one failed instead of swallowing
// the whole batch (#955 — the empty catch here hid a failed foreign_keys=ON, which
// leaves every shared-cascade ON DELETE clause silently inert). Non-FK pragmas are
// perf/contention tuning and legitimately non-fatal (e.g. journal_mode=WAL fails on
// a read-only DB), so a failure is logged but does not abort.
async function applyPragmas(c: ReturnType<typeof createClient>) {
  for (const [pragma, rationale] of PRAGMAS) {
    try {
      await c.execute(pragma);
    } catch (err) {
      console.error(
        `[mcp-db] ${pragma} failed (${rationale}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Apply the same pragma discipline as the server DB entrypoint so MCP tools
// cannot bypass FK enforcement and tolerate normal server write contention.
const client = createClient({ url });
await applyPragmas(client);
// Mirror the server's #894 startup guard (assertForeignKeysEnabled in startup-tasks):
// read PRAGMA foreign_keys back and refuse to start if it is OFF — MCP's delete_issue
// runs the shared cascade on this connection, so inert FKs must be a loud failure,
// not a silent one. Same severity as the server: throw (kills MCP startup).
await assertForeignKeysEnabled(client, "MCP");

export const db = drizzle({ client, schema });
export const rawClient = client;
export { schema };
