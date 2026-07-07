/**
 * Shared libsql connection pragmas (#987, unified in arch-review §2.3).
 *
 * FK enforcement (and the WAL/perf settings) are PER CONNECTION in SQLite/libsql.
 * `db/index.ts` always applied them to the server's read/write connections, but
 * ad-hoc scripts (db-repair, one-off queries) created bare `createClient(...)`
 * clients with NO pragmas — those connections silently ran with `foreign_keys=OFF`
 * and could insert FK-violating rows into the live DB.
 *
 * The pragma list + its error policy used to be duplicated here AND in
 * `packages/mcp-server/src/db.ts` with divergent semantics. Both now delegate to
 * the ONE factory in `@agentic-kanban/shared/lib/db-client`; this module is a thin
 * back-compat re-export so existing server-side imports keep working.
 */
export { applyPragmas, createClientWithPragmas, CONNECTION_PRAGMAS } from "@agentic-kanban/shared/lib/db-client";
