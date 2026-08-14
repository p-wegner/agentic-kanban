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
 */
export function applyMigrationsToClient(client: Client): void {
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }
}

/**
 * Temp-file paths created by createTestDb(), removed once on process exit.
 * Most callers don't dispose the DB (the return shape is just `{ client, db }`),
 * so a single best-effort sweep keeps the OS temp dir from accumulating files
 * across a full test run.
 */
const createdTempDbFiles: string[] = [];

/**
 * Every client handed out by createTestDb, so the fork can CLOSE them before it exits (#471).
 *
 * Measured: 248 test files call `createTestDb`, 7 of them ever call `dispose`. Most create a DB
 * per test in `beforeEach`, so a worker reaches teardown holding hundreds of open libsql clients
 * — and libsql's client is a native (Rust/napi) handle, not a JS object the GC can simply drop.
 *
 * That matches the failure this exists to remove: a vitest worker dying with NO failing test and
 * no JS error ("Worker exited unexpectedly"), in a run where all 174 files passed. A crash during
 * native teardown looks exactly like that — every test is green and the run still exits non-zero,
 * because vitest counts an unhandled worker exit as a failure. The pre-merge gate then withholds
 * every merge board-wide for a reason no log names.
 *
 * Closing them here is a fork-wide fix that does not require editing 241 files (and being right
 * in all of them). Individual `dispose()` calls remain the tidier per-test option and still work.
 */
const createdClients: Client[] = [];
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    // Close BEFORE unlinking: a client still holding the file keeps its -wal/-shm alive on
    // Windows, which is also why the old sweep left files behind.
    for (const client of createdClients) {
      try {
        client.close();
      } catch {
        /* already closed, or closing during teardown — never fail the run over cleanup */
      }
    }
    createdClients.length = 0;
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
  // Tracked so the fork closes it at exit even when the caller never disposes (#471).
  createdClients.push(client);
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  const dispose = (): void => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    const tracked = createdClients.indexOf(client);
    if (tracked !== -1) createdClients.splice(tracked, 1);
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
