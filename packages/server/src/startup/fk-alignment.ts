/**
 * Startup FK-integrity guard (arch-review #894).
 *
 * Two distinct holes this closes, both invisible until a long-lived on-disk
 * `kanban.db` (the dev board's own, which is forbidden from being wiped) hits them:
 *
 *  1. **FK-action drift is only repaired on manual `db:repair`.** `alignForeignKeyActions`
 *     (`fk-actions-repair.ts`) was wired ONLY into `scripts/db-repair.ts`, never into
 *     server startup. Migrations bring the schema *shape* up to date but cannot retro-fit
 *     an `ON DELETE` action onto a table an older DB created without one (SQLite has no
 *     `ALTER ... FOREIGN KEY`). So a live DB could keep RESTRICT/NO-ACTION where the
 *     schema says cascade — masked today only because the hand-rolled `cascade-delete.ts`
 *     deletes children in the right order, leaving the live FK actions unverified against
 *     code assumptions.
 *
 *  2. **A failed `PRAGMA foreign_keys=ON` was swallowed** (`db/index.ts`). On a real
 *     on-disk client a failed pragma silently disables EVERY `onDelete` clause with no
 *     log or assert. We now read the pragma back and fail loud if it didn't take.
 *
 * Run after migrations, before the server accepts traffic. The alignment itself is
 * data-preserving (rebuilds only drifted tables; column shape untouched) and idempotent —
 * a clean DB is a no-op.
 */
import { alignForeignKeyActions } from "@agentic-kanban/shared/lib/fk-actions-repair";
import type { FkRepairClient } from "@agentic-kanban/shared/lib/fk-actions-repair";

/** Minimal client surface the startup guard needs (execute returning rows). */
export interface PragmaClient {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read `PRAGMA foreign_keys` back from the live connection and throw if it is not
 * enabled. SQLite/libsql enforce FK constraints PER CONNECTION, and a failed
 * `PRAGMA foreign_keys=ON` leaves every `ON DELETE` clause inert with no error of its
 * own. This turns that silent failure into a loud one.
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

/**
 * Bring a live DB's FK ACTIONS into line with the Drizzle schema on startup, repairing
 * the drift that only `db:repair` used to fix. Logs each mismatch it repairs; a clean DB
 * is a silent no-op. Returns the repair result for callers/tests.
 *
 * This is intentionally NON-fatal at the call site (a rebuild failure must not stop the
 * board from starting — the migrations already ran and the schema shape is correct); the
 * caller wraps it. The pragma assertion above is the part that IS fatal.
 */
export async function alignForeignKeyActionsOnStartup(client: FkRepairClient) {
  const result = await alignForeignKeyActions(client);
  if (result.driftedTables.length === 0) {
    return result;
  }
  for (const m of result.mismatches) {
    console.warn(
      `[startup] FK-action drift: ${m.table}.${m.fk} ${m.field} — schema=${m.expected} live=${m.actual}`,
    );
  }
  console.log(
    `[startup] aligned FK actions on the live DB by rebuilding: ${result.rebuiltTables.join(", ")}`,
  );
  return result;
}
