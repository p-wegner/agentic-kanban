import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";

// Resolve DB path: prefer env var, then try relative to this file (monorepo dev), then CWD
function resolveDbPath(): string {
  if (process.env.DB_URL) return process.env.DB_URL;
  // Monorepo dev: ../../server/kanban.db relative to this file
  const devPath = resolve(import.meta.dirname, "../../server/kanban.db");
  if (existsSync(devPath)) return devPath;
  // Published/fallback: kanban.db in current working directory
  return resolve(process.cwd(), "kanban.db");
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
