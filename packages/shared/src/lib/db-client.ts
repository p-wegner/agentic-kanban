/**
 * Single libsql connection-bootstrap factory (arch-review §2.3, #987).
 *
 * FK enforcement and the WAL/perf settings are PER CONNECTION in SQLite/libsql.
 * The server (`packages/server/src/db/pragmas.ts`) and the MCP server
 * (`packages/mcp-server/src/db.ts`) each used to ship their OWN copy of the same
 * 7-pragma list with DIVERGENT error semantics (server aborted the whole batch on
 * the first failure and its caller caught the batch; MCP continued per-pragma and
 * logged). A pragma added to one side failed no test on the other. This module is
 * now the ONE place that list and its error policy live; both packages delegate
 * here, and ad-hoc scripts must use `createClientWithPragmas` instead of a bare
 * `createClient(...)` (which leaves `foreign_keys=OFF` for the whole connection —
 * the #987 disease: it silently inserts FK-violating rows into the live DB).
 *
 * Node-only. Import via the DEEP PATH `@agentic-kanban/shared/lib/db-client`
 * (it value-imports `@libsql/client`, a Node module) — NEVER re-export it through
 * the client-reachable `src/lib/index.ts` barrel (#791 white-screen). MCP speaks
 * JSON-RPC over stdout, so all diagnostics here go to stderr (`console.warn`).
 */
import { createClient } from "@libsql/client";

type LibsqlClient = ReturnType<typeof createClient>;

/**
 * One pragma spec. `critical` marks the invariant a connection must never run
 * without — `foreign_keys=ON` — because a silently-off FK pragma leaves every
 * `ON DELETE` clause inert (#955). The remaining entries are WAL/perf tuning that
 * can legitimately fail (e.g. `journal_mode=WAL` on a read-only DB) and must NOT
 * take the connection down with them.
 */
interface PragmaSpec {
  readonly pragma: string;
  readonly rationale: string;
  readonly critical: boolean;
}

/** The single connection-pragma list. Order matters: FK first. */
export const CONNECTION_PRAGMAS: ReadonlyArray<PragmaSpec> = [
  // foreign_keys=ON: SQLite/libsql enforce FK constraints per connection. CRITICAL —
  // a connection that fails to enable this must not be used (every ON DELETE is inert).
  { pragma: "PRAGMA foreign_keys=ON", rationale: "FK enforcement (per connection)", critical: true },
  // journal_mode=WAL: multiple readers never block a writer; writer doesn't block readers.
  { pragma: "PRAGMA journal_mode=WAL", rationale: "WAL journal mode", critical: false },
  // busy_timeout: wait up to 10s for a locked DB before throwing SQLITE_BUSY.
  { pragma: "PRAGMA busy_timeout=10000", rationale: "busy timeout", critical: false },
  // synchronous=NORMAL: crash-safe with WAL; removes an fsync per commit.
  { pragma: "PRAGMA synchronous=NORMAL", rationale: "synchronous=NORMAL", critical: false },
  // temp_store=MEMORY: keep transient B-trees in RAM.
  { pragma: "PRAGMA temp_store=MEMORY", rationale: "temp_store=MEMORY", critical: false },
  // cache_size=-65536: 64MB page cache.
  { pragma: "PRAGMA cache_size=-65536", rationale: "page cache size", critical: false },
  // mmap_size=256MB: memory-map reads to cut syscall overhead.
  { pragma: "PRAGMA mmap_size=268435456", rationale: "mmap size", critical: false },
];

/**
 * Apply the standard connection pragmas to an existing client.
 *
 * UNIFIED error semantics (the one policy, safer than either fork):
 * - each pragma is applied individually, so a benign non-critical failure never
 *   aborts the rest of the list (MCP's resilience — WAL fails on a read-only DB);
 * - a NON-critical failure is logged to stderr and tolerated;
 * - a CRITICAL failure (`foreign_keys=ON`) THROWS immediately (the server's
 *   abort-on-failure safety) — a connection without FK enforcement must never be
 *   silently handed out. Callers that must diagnose a broken DB catch and inspect.
 */
export async function applyPragmas(c: LibsqlClient): Promise<void> {
  for (const { pragma, rationale, critical } of CONNECTION_PRAGMAS) {
    try {
      await c.execute(pragma);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (critical) {
        throw new Error(`Critical pragma \`${pragma}\` (${rationale}) failed: ${msg}`);
      }
      // Non-fatal perf/contention tuning — log (stderr) and continue.
      console.warn(`[db-client] ${pragma} failed (${rationale}): ${msg}`);
    }
  }
}

/**
 * Create a libsql client with the standard pragmas already applied — the factory
 * scripts and package bootstraps must use instead of a bare `createClient` (which
 * leaves FK enforcement OFF for the whole connection). Throws if a critical pragma
 * cannot be applied (e.g. the file is not a valid SQLite database, or FK could not
 * be enabled); the half-open client is closed before the throw so callers that must
 * diagnose broken DBs can catch and inspect the error without leaking a handle.
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
