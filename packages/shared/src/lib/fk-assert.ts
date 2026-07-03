/**
 * FK-enforcement runtime assertion (#894, propagated to the MCP server in #955).
 *
 * SQLite/libsql enforce foreign-key constraints PER CONNECTION, and a failed
 * `PRAGMA foreign_keys=ON` leaves every `ON DELETE` clause silently inert with
 * no error of its own. Both the server startup path and the MCP server's DB
 * entrypoint read the pragma back after connecting and fail loud if it did not
 * take. Node-only (deep-path import: `@agentic-kanban/shared/lib/fk-assert`).
 */

/** Minimal client surface the assertion needs (execute returning rows). */
export interface PragmaClient {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read `PRAGMA foreign_keys` back from the live connection and throw if it is
 * not enabled. This turns the silent "pragma failed / was swallowed" failure
 * mode into a loud one.
 */
export async function assertForeignKeysEnabled(
  client: PragmaClient,
  label = "connection",
): Promise<void> {
  const res = await client.execute("PRAGMA foreign_keys");
  // PRAGMA foreign_keys returns a single row `{ foreign_keys: 0 | 1 }`.
  const row = res.rows[0] as { foreign_keys?: number | bigint } | undefined;
  const enabled = Number(row?.foreign_keys ?? 0) === 1;
  if (!enabled) {
    throw new Error(
      `PRAGMA foreign_keys is OFF on the ${label} connection — every ON DELETE clause ` +
        `is silently inert. The pragma failed to apply (read-only DB, or the PRAGMA was ` +
        `swallowed). Refusing to start with FK enforcement disabled.`,
    );
  }
}
