import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Shared drizzle migrations dir, resolved relative to this file. */
export const MIGRATIONS_DIR = resolve(__dirname, "../../../../shared/drizzle");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

interface JournalEntry { tag: string }

/** Migration tags in journal apply-order — NOT lexical (e.g. 0023 runs before 0020). */
export function migrationFilesInOrder(): string[] {
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8")) as { entries: JournalEntry[] };
  return journal.entries.map((e) => `${e.tag}.sql`);
}

/**
 * Apply every migration to a libsql client, in the order recorded in the drizzle
 * journal. Reading the journal (rather than a hardcoded list or a lexical sort)
 * keeps the helper correct as migrations are added and preserves the non-lexical
 * apply order the journal encodes.
 */
export function applyMigrationsToClient(client: Client): void {
  for (const file of migrationFilesInOrder()) {
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
  const file = join(tmpdir(), `mcp-test-db-${randomUUID()}.db`);
  createdTempDbFiles.push(file);
  const client = createClient({ url: `file:${file}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  return { client, db };
}
