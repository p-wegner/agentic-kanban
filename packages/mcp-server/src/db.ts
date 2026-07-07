import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { assertForeignKeysEnabled } from "@agentic-kanban/shared/lib/fk-assert";
import { resolveDbLocation } from "@agentic-kanban/shared/lib/db-path";
import { applyPragmas } from "@agentic-kanban/shared/lib/db-client";

// Resolve the DB via the SHARED resolver so the MCP server and the HTTP server
// (packages/server/src/db/data-dir.ts) agree on ONE precedence (#962). The MCP
// server used to let a present monorepo dev DB outrank AGENTIC_KANBAN_DIR — so
// with the env var set the two processes silently opened different databases.
// Now an explicit env override (DB_URL / AGENTIC_KANBAN_DIR) ALWAYS wins; the
// monorepo dev DB (../../server/kanban.db, relative to this file) is only the
// in-checkout probe used when no env override is set. `import.meta.dirname`
// resolves to a real dev path only inside the monorepo, so the candidate simply
// doesn't exist for published installs.
const location = resolveDbLocation({
  localDbCandidates: [resolve(import.meta.dirname, "../../server/kanban.db")],
});
const url = location.url;

// Log the resolved absolute DB path at startup so a split-brain is visible.
// MCP speaks JSON-RPC over stdout, so diagnostics MUST go to stderr.
console.error(`[mcp-db] opening ${location.path ?? url} (source: ${location.source})`);

// Ensure the target directory exists (the home-dir fallback may not yet).
if (location.dir && !existsSync(location.dir)) mkdirSync(location.dir, { recursive: true });

// Apply the same pragma discipline as the server DB entrypoint so MCP tools
// cannot bypass FK enforcement and tolerate normal server write contention. The
// pragma list + error policy live in ONE place now (the shared factory,
// arch-review §2.3): both the server and this MCP entrypoint call `applyPragmas`,
// so a pragma added on one side can no longer silently miss the other. The shared
// policy logs non-critical pragma failures to stderr (MCP-safe) and THROWS on a
// failed critical `foreign_keys=ON` — the assertForeignKeysEnabled read-back below
// remains as defence-in-depth against a silently no-op'd pragma.
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
