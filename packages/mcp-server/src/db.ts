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

// Apply WAL mode and busy_timeout so the MCP server doesn't fail with SQLITE_BUSY
// when the main server is writing. WAL allows concurrent reads, and busy_timeout
// retries writes for up to 10s before giving up.
const client = createClient({ url });
try {
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA busy_timeout=10000");
} catch {
  // Non-fatal: pragmas may fail on read-only or in-memory DBs.
}

export const db = drizzle({ client, schema });
export { schema };
