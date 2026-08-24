import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MIGRATIONS_DIR, migrationFilesInOrder, readMigrationStatements } from "@agentic-kanban/shared/lib/migration-source";
import * as schema from "@agentic-kanban/shared/schema";


export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// #562: MIGRATIONS_DIR + migrationFilesInOrder were a byte-for-byte fork of the server's
// helper — one that had never picked up the #471 client-close fix. Both now come from the
// shared migration-source module, so there is nothing left here to diverge.
export {
  MIGRATIONS_DIR,
  migrationFilesInOrder,
} from "@agentic-kanban/shared/lib/migration-source";

/**
 * Apply every migration to a libsql client, in the order recorded in the drizzle
 * journal. Reading the journal (rather than a hardcoded list or a lexical sort)
 * keeps the helper correct as migrations are added and preserves the non-lexical
 * apply order the journal encodes.
 */
export function applyMigrationsToClient(client: Client): void {
  for (const file of migrationFilesInOrder()) {
    for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) {
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
let exitCleanupRegistered = false;

/**
 * One directory per process, in the reaper's `ak-` namespace, holding every throwaway `.db`
 * this helper mints (#840).
 *
 * A LOOSE FILE is in no swept namespace whatever it is called: the fixture reaper is gated on
 * `statSync(...).isDirectory()`, so renaming `mcp-test-db-<uuid>.db` to `ak-mcp-test-db-…`
 * would have read as a fix and changed nothing. The `process.on("exit")` sweep below does not
 * run on a killed vitest worker, and libsql's native handle can hold a `-wal`/`-shm` past it
 * even when it does — so without a directory there is no recovery path at all. Inside one,
 * whatever this process fails to remove the next run's sweep removes two hours later.
 */
let processTempDbDir: string | null = null;
function tempDbDir(): string {
  if (processTempDbDir) return processTempDbDir;
  processTempDbDir = mkdtempSync(join(tmpdir(), "ak-mcp-test-db-"));
  return processTempDbDir;
}

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
 * Create a file-backed libsql DB (temp file) with all migrations applied.
 *
 * A temp FILE is used instead of `:memory:` because the libsql native binding
 * loses an in-memory database across a `db.transaction()` commit on newer Node
 * runtimes (Node 26 + @libsql/client 0.14 / libsql 0.4.7): a subsequent
 * base-connection SELECT throws "no such table". This made every transactional
 * cascade test (delete_workspace/delete_issue) baseline-red. A file-backed DB is
 * connection-stable, so the behaviour under test is exercised honestly and
 * deterministically. Temp files are swept on process exit.
 */
export function createTestDb(): { client: Client; db: TestDb } {
  registerExitCleanup();
  const file = join(tempDbDir(), `mcp-test-db-${randomUUID()}.db`);
  createdTempDbFiles.push(file);
  const client = createClient({ url: `file:${file}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  return { client, db };
}
