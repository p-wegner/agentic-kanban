import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./migrations.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Applies all MIGRATION_FILES to a libsql Client (in-memory or file-based).
 * Shared by createTestDb() and CLI tests that need a file-backed database.
 *
 * Also stamps `__drizzle_migrations` (same table/columns `applyMigrations` in
 * `db/manual-migrate.ts` uses to track what's applied). Without this, a CLI test
 * that spawns a subprocess against this file-backed DB (`runCli()`) triggers that
 * subprocess's own `runMigrations()` — which finds no bookkeeping, assumes
 * NOTHING is applied, and replays every migration from scratch against an
 * already-migrated DB, blowing up on non-idempotent DDL (`DROP TABLE` FK
 * failures, "table already exists"). Recording each tag here as it's applied
 * keeps the two migration runners' bookkeeping in sync.
 */
export function applyMigrationsToClient(client: Client): void {
  client.execute(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at number
    )
  `);
  for (const file of MIGRATION_FILES) {
    const tag = file.replace(/\.sql$/, "");
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
    client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [tag, Date.now()] });
  }
}

/**
 * Temp-file paths created by createTestDb(), removed once on process exit.
 * Most callers don't dispose the DB (the return shape is just `{ client, db }`),
 * so a single best-effort sweep keeps the OS temp dir from accumulating files
 * across a full test run.
 */
const createdTempDbFiles: string[] = [];
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    for (const file of createdTempDbFiles) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${file}${suffix}`, { force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }
    }
  });
}

/**
 * Creates a file-backed libsql client (temp file) with all migrations applied.
 * Returns the drizzle `db` instance and the raw `client`.
 *
 * A temp FILE is used instead of `:memory:` because the libsql native binding
 * loses an in-memory database across a `db.transaction()` commit on newer Node
 * runtimes (Node 26 + @libsql/client 0.14 / libsql 0.4.7): a subsequent
 * base-connection SELECT throws "no such table". This made every transactional
 * cascade test baseline-red. A file-backed DB is connection-stable, so the
 * behaviour under test is exercised honestly and deterministically. Temp files
 * are swept on process exit; callers that want eager cleanup can call `dispose()`.
 */
export function createTestDb() {
  registerExitCleanup();
  const file = join(tmpdir(), `test-db-${randomUUID()}.db`);
  createdTempDbFiles.push(file);
  const client = createClient({ url: `file:${file}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  const dispose = (): void => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${file}${suffix}`, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  };
  return { client, db, dispose };
}
