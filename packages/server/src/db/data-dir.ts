import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDbLocation, type DbLocation } from "@agentic-kanban/shared/lib/db-path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In-checkout dev DB candidates, both pointing at packages/server/kanban.db:
//   - bundled mode (__dirname = dist/)   → ../kanban.db
//   - dev mode     (__dirname = src/db/) → ../../kanban.db
const LOCAL_DB_CANDIDATES = [
  resolve(__dirname, "../kanban.db"),
  resolve(__dirname, "../../kanban.db"),
];

// Resolved ONCE at module load via the shared resolver so the HTTP server and the
// MCP server (packages/mcp-server/src/db.ts) agree on ONE precedence (#962).
export const DB_LOCATION: DbLocation = resolveDbLocation({
  localDbCandidates: LOCAL_DB_CANDIDATES,
});

// Directory that holds the DB (and its .db-backups) — used by backup.ts and
// ensureDataDir. A non-`file:` DB_URL has no dir, so fall back to the home dir.
export const DATA_DIR = DB_LOCATION.dir ?? join(homedir(), ".agentic-kanban");

export function getDbUrl(): string {
  return DB_LOCATION.url;
}

export function ensureDataDir(): string {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

export function dbExists(): boolean {
  return DB_LOCATION.path ? existsSync(DB_LOCATION.path) : false;
}
