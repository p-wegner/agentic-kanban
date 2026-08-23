import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveMigrationsDir, splitMigrationStatements, type JournalEntry } from "@agentic-kanban/shared/lib/migration-source";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getMigrationsFolder(): string {
  // The candidate ORDER is the load-bearing part: a FLAT bundle (dist/cli.js) finds
  // migrations at ./migrations, a NESTED bundle (dist/cli/index.js) at ../migrations, and
  // dev/monorepo runs fall back to the shared drizzle dir. (A previous hardcoded
  // "./migrations" broke the published CLI once the entry moved to dist/cli/index.js.)
  // The probing itself is `resolveMigrationsDir` (#562) — `db/migrations.ts` held a second,
  // OLDER copy of this that never got the fix and had gone dead.
  return resolveMigrationsDir([
    resolve(__dirname, "migrations"),              // flat bundle   → dist/migrations
    resolve(__dirname, "../migrations"),           // nested bundle → dist/migrations
    resolve(__dirname, "../../../shared/drizzle"), // dev / monorepo
  ]);
}



/**
 * Idempotency-shim cutoff (#954).
 *
 * Historically the runner swallowed "duplicate column name" / "already exists"
 * errors on EVERY migration, because DBs that predate reliable
 * `__drizzle_migrations` tracking may be part-applied and re-running their DDL
 * is the only way forward. That tolerance is only legitimate for those legacy
 * migrations: 0000–0096 (the newest migration at the time #954 landed).
 * Migrations with a journal idx ABOVE this cutoff were created after tracking
 * was reliable, so a "duplicate column"/"already exists" error there is a REAL
 * failure and must abort.
 */
export const LEGACY_IDEMPOTENCY_CUTOFF_IDX = 96;

/** First ~140 chars of a statement, flattened, for log lines. */
function stmtSnippet(stmt: string): string {
  const flat = stmt.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/**
 * Does this migration toggle `PRAGMA foreign_keys`? Such migrations MUST run
 * outside a transaction: SQLite documents `PRAGMA foreign_keys` as a NO-OP while
 * a transaction is open, so wrapping them in `client.transaction("write")` (as
 * every other migration is) silently ignores the OFF/ON toggle and runs the whole
 * file under the connection's ambient FK state. The FK-off "table rebuild" pattern
 * (0010/0039/0096: create `_new`, copy, DROP the old table, rename) then aborts on
 * any populated DB where FK enforcement is ON — 0039 drops `projects`, the parent
 * of nearly every table. Running these statement-by-statement in autocommit makes
 * the pragma actually take effect. (arch-review 2026-07-07 §3.1)
 */
function togglesForeignKeys(statements: string[]): boolean {
  return statements.some((s) => /\bPRAGMA\s+foreign_keys\b/i.test(s));
}

/**
 * Execute one migration statement against `exec`, applying two tolerances shared
 * by both the transactional and the outside-transaction runners:
 *  - the spurious libsql SQLITE_OK "not an error" (always tolerated), and
 *  - the legacy "duplicate column"/"already exists" idempotency shim, scoped to
 *    migrations at or below LEGACY_IDEMPOTENCY_CUTOFF_IDX and never silent.
 * Rethrows anything else so the caller can roll back / abort.
 */
async function runMigrationStatement(
  exec: (stmt: string) => Promise<unknown>,
  stmt: string,
  entry: JournalEntry,
): Promise<void> {
  try {
    await exec(stmt);
  } catch (err: unknown) {
    const message = errorMessage(err);
    const code = (err as { code?: unknown } | null | undefined)?.code;
    // Ignore spurious SQLITE_OK "not an error" from libsql (client bug,
    // not a migration-state issue — always tolerated).
    if (code === "SQLITE_OK" || message.includes("not an error")) {
      return;
    }
    // Legacy idempotency shim: pre-tracking DBs may be part-applied, so
    // re-running their DDL hits "duplicate column"/"already exists".
    // Only tolerated below the cutoff, and never silently.
    if (
      entry.idx <= LEGACY_IDEMPOTENCY_CUTOFF_IDX &&
      (message.includes("duplicate column name") || message.includes("already exists"))
    ) {
      console.warn(
        `[migrate] idempotency shim fired for legacy migration ${entry.tag}: tolerating "${message}" ` +
        `(statement: ${stmtSnippet(stmt)}) — pre-#954 DBs may be part-applied; a real failure here would be masked`,
      );
      return;
    }
    throw err;
  }
}

/** Read the connection's current `PRAGMA foreign_keys` value (0/1), or null if unknown. */
async function readForeignKeysState(client: Client): Promise<boolean | null> {
  try {
    const res = await client.execute("PRAGMA foreign_keys");
    const raw = (res.rows[0] as { foreign_keys?: unknown } | undefined)?.foreign_keys
      ?? (res.rows[0] ? Object.values(res.rows[0])[0] : undefined);
    if (raw === undefined || raw === null) return null;
    return Number(raw) === 1;
  } catch {
    return null;
  }
}

/**
 * Apply a migration that toggles `PRAGMA foreign_keys` OUTSIDE a transaction so
 * the pragma actually takes effect. File-level atomicity is not available here —
 * that is inherent to the FK-off table-rebuild pattern (the pragma cannot live
 * inside a tx) — but the connection's prior FK-enforcement state is captured and
 * restored afterward (success AND failure) so a mid-migration abort can never
 * leave FK enforcement silently off for the rest of the process.
 */
async function applyMigrationOutsideTransaction(
  client: Client,
  entry: JournalEntry,
  statements: string[],
): Promise<void> {
  const priorForeignKeys = await readForeignKeysState(client);
  let failingStmt = "";
  try {
    for (const stmt of statements) {
      failingStmt = stmt;
      await runMigrationStatement((s) => client.execute(s), stmt, entry);
    }
    await client.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [entry.tag, entry.when],
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.error(
      `[migrate] Migration ${entry.tag} FAILED (ran outside a transaction — FK-toggling migration). ` +
      `Failing statement: ${stmtSnippet(failingStmt)}. Partial statements are NOT rolled back; aborting — ` +
      `later migrations were NOT attempted.`,
    );
    throw new Error(`Migration ${entry.tag} failed: ${message}`, { cause: err });
  } finally {
    // Restore the connection's baseline FK-enforcement state regardless of where
    // the migration's own OFF/ON toggles left it (or whether it aborted early).
    if (priorForeignKeys !== null) {
      try {
        await client.execute(`PRAGMA foreign_keys=${priorForeignKeys ? "ON" : "OFF"}`);
      } catch { /* best-effort restore */ }
    }
  }
}

/**
 * A migration recorded as applied under a DIFFERENT tag but the SAME index (#825).
 *
 * `applyMigrations` decides applied-ness by tag STRING, so renaming a `.sql` after it has run
 * locally makes an already-applied migration look pending. Re-running its DDL then fails with
 * `table ... already exists`, and — because the tag is the only key — it fails identically on
 * every subsequent boot. The dev board was bricked exactly this way: `__drizzle_migrations`
 * held `0140_mature_firebird` (drizzle-kit's generated name) while the journal had been
 * renamed to `0140_workspace_setup_run` before the commit.
 *
 * Renaming is not the mistake — every recent migration here is renamed to something
 * descriptive, because `0140_mature_firebird` tells a reader nothing. The mistake is that the
 * error blamed the DDL, when the DB already held the one fact that explains it.
 *
 * This DIAGNOSES only. It deliberately does not reconcile the row or tolerate the failure:
 * silently accepting `already exists` on a modern migration would mask genuinely
 * non-idempotent DDL, which is the failure `LEGACY_IDEMPOTENCY_CUTOFF_IDX` exists to keep
 * visible. Best-effort — any error here yields no hint rather than replacing the real one.
 */
export async function findRenamedSiblingTag(client: Client, tag: string): Promise<string | null> {
  const idx = /^(\d+)_/.exec(tag)?.[1];
  if (!idx) return null;
  try {
    // Filtered in JS rather than with `LIKE '<idx>_%'`: in SQL LIKE, `_` is a single-character
    // WILDCARD, so that pattern also matches a longer index (`01405_foo` for idx `0140`). The
    // tracking table holds one row per migration, so reading it whole costs nothing and the
    // comparison is then exact.
    const result = await client.execute("SELECT hash FROM __drizzle_migrations");
    for (const row of result.rows as Array<{ hash?: unknown }>) {
      if (row.hash === undefined || row.hash === null) continue;
      const hash = String(row.hash);
      if (hash !== tag && /^(\d+)_/.exec(hash)?.[1] === idx) return hash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply a normal migration inside ONE write transaction: its statements and the
 * `__drizzle_migrations` bookkeeping row commit together, or the whole file rolls
 * back and the run aborts (later migrations are never attempted).
 */
async function applyMigrationInTransaction(
  client: Client,
  entry: JournalEntry,
  statements: string[],
): Promise<void> {
  const tx = await client.transaction("write");
  let failingStmt = "";
  try {
    for (const stmt of statements) {
      failingStmt = stmt;
      await runMigrationStatement((s) => tx.execute(s), stmt, entry);
    }
    // Record migration as applied (use tag as hash to match drizzle-kit format)
    await tx.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [entry.tag, entry.when],
    });
    await tx.commit();
  } catch (err: unknown) {
    try {
      await tx.rollback();
    } catch { /* transaction already closed */ }
    const message = errorMessage(err);
    console.error(
      `[migrate] Migration ${entry.tag} FAILED and was rolled back. ` +
      `Failing statement: ${stmtSnippet(failingStmt)}. Aborting — later migrations were NOT attempted.`,
    );
    // `already exists` / `duplicate column` on a modern migration is usually a RENAME, not
    // broken DDL — say so, because the message alone points at the wrong thing (#825).
    let hint = "";
    if (message.includes("already exists") || message.includes("duplicate column name")) {
      const sibling = await findRenamedSiblingTag(client, entry.tag);
      if (sibling) {
        hint =
          ` NOTE: ${sibling} is already recorded as applied and shares this migration's index. ` +
          `This looks like a migration that was applied and then RENAMED, so its DDL has already run. ` +
          `Verify the schema really is in the post-migration state, then reconcile the tracking row ` +
          `(UPDATE __drizzle_migrations SET hash='${entry.tag}' WHERE hash='${sibling}') — do NOT ` +
          `re-run the migration, and do NOT reset the database.`;
        console.error(`[migrate]${hint}`);
      }
    }
    throw new Error(`Migration ${entry.tag} failed: ${message}${hint}`, { cause: err });
  } finally {
    tx.close();
  }
}

/**
 * Apply migrations manually using the raw libsql client.
 *
 * Works around a libsql@0.4.7 + Node.js 26 bug where CREATE TABLE IF NOT EXISTS
 * returns SQLITE_OK (0), which libsql misinterprets as an error, causing
 * drizzle-orm's migrate() to abort partway through.
 *
 * Guarantees (#954):
 * - Each migration file runs inside ONE write transaction (statements + the
 *   `__drizzle_migrations` bookkeeping row commit together). A failing
 *   statement rolls the whole file back and aborts the run — later migrations
 *   are never attempted on top of a half-applied one.
 * - A journal entry whose .sql file is missing is a HARD error (a published
 *   bundle ships journal + .sql together via scripts/copy-assets.mjs, so a
 *   missing file means the install is broken — silently skipping it would
 *   leave the schema behind the journal with no visible symptom).
 * - The "duplicate column name"/"already exists" tolerance is scoped to legacy
 *   migrations (idx <= LEGACY_IDEMPOTENCY_CUTOFF_IDX) that are NOT recorded as
 *   applied, and it logs a loud warning whenever it fires.
 *
 * @param options.folder Override the migrations folder (tests inject a synthetic
 *   journal + .sql files; production callers omit it).
 */
/**
 * Journal tags that `applyMigrations` would actually run right now (#322).
 *
 * The pre-migration backup exists as insurance against a schema change, but it
 * was taken on EVERY boot, before anyone asked whether there was a schema change
 * to insure. On a ~103 MB DB that is a full-size `VACUUM INTO` per process
 * start, and under `tsx watch` the process starts on every source edit. Callers
 * use this to pay for the snapshot only when a migration is genuinely pending.
 *
 * Fails SAFE: any error reading the journal or the tracking table returns
 * `null`, which callers must treat as "unknown — take the backup".
 */
export async function pendingMigrationTags(
  client: Client,
  options?: { folder?: string },
): Promise<string[] | null> {
  try {
    const folder = options?.folder ?? getMigrationsFolder();
    const journalPath = resolve(folder, "meta/_journal.json");
    if (!existsSync(journalPath)) return null;
    const journalRaw = readFileSync(journalPath, "utf8");
    if (journalRaw.includes("<<<<<<<")) return null;
    const entries = (JSON.parse(journalRaw) as { entries: JournalEntry[] }).entries;
    const result = await client.execute("SELECT hash FROM __drizzle_migrations");
    const applied = new Set(result.rows.map((r) => String((r as { hash?: string }).hash)));
    return entries.filter((e) => !applied.has(e.tag)).map((e) => e.tag);
  } catch {
    // Includes "no such table: __drizzle_migrations" on a fresh DB — unknown,
    // so the caller takes the backup.
    return null;
  }
}

export async function applyMigrations(client: Client, options?: { folder?: string }): Promise<void> {
  const folder = options?.folder ?? getMigrationsFolder();
  const journalPath = resolve(folder, "meta/_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal not found at ${journalPath}`);
  }

  const journalRaw = readFileSync(journalPath, "utf8");
  if (journalRaw.includes("<<<<<<<")) {
    throw new Error(
      `[startup] FATAL: ${journalPath} contains git conflict markers — the repository is mid-merge. ` +
      `Run 'git merge --abort' in the main checkout to recover, then restart the server.`,
    );
  }
  const journal = JSON.parse(journalRaw) as { entries: JournalEntry[] };
  const entries: JournalEntry[] = journal.entries;

  // Create drizzle's migration tracking table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at number
    )
  `);

  // Check which migrations are already applied (by tag/hash to be compatible with drizzle-kit)
  let appliedTags = new Set<string>();
  try {
    const result = await client.execute("SELECT hash FROM __drizzle_migrations");
    appliedTags = new Set(result.rows.map((r) => String((r as { hash?: string }).hash)));
  } catch { /* table doesn't exist yet */ }

  for (const entry of entries) {
    if (appliedTags.has(entry.tag)) continue;

    const sqlFile = resolve(folder, `${entry.tag}.sql`);
    if (!existsSync(sqlFile)) {
      throw new Error(
        `[migrate] Journal entry "${entry.tag}" has no SQL file at ${sqlFile}. ` +
        `The migrations bundle is incomplete (journal and .sql files must ship together). ` +
        `Refusing to continue — skipping would silently leave the schema behind the journal.`,
      );
    }

    const sql = readFileSync(sqlFile, "utf8");

    // Split on statement breakpoints
    const statements = splitMigrationStatements(sql, entry.breakpoints);

    // A migration that toggles `PRAGMA foreign_keys` MUST run outside a
    // transaction (SQLite ignores the pragma inside one — the §3.1 bug); every
    // other migration runs atomically inside one write transaction.
    if (togglesForeignKeys(statements)) {
      await applyMigrationOutsideTransaction(client, entry, statements);
    } else {
      await applyMigrationInTransaction(client, entry, statements);
    }
  }
}

/**
 * Bootstrap helper: apply all pending migrations against the live raw client.
 * Lives in the db layer (not cli/) so CLI command modules can run migrations
 * without importing db/index directly. Imported by cli/shared.ts.
 */
export async function runMigrations(): Promise<void> {
  const { rawClient } = await import("./index.js");
  await applyMigrations(rawClient);
}
