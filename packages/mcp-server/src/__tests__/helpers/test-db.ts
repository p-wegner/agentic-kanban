import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Create an in-memory libsql DB with all migrations applied. */
export function createTestDb(): { client: Client; db: TestDb } {
  const client = createClient({ url: ":memory:" });
  applyMigrationsToClient(client);
  const db = drizzle(client, { schema });
  return { client, db };
}
