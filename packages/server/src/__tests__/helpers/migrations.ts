import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = resolve(__dirname, "../../../../shared/drizzle");

interface JournalEntry { tag: string }

/**
 * Migration tags in journal apply-order — NOT lexical (e.g. 0023 runs before 0020).
 * Read from the drizzle journal so this never goes stale as migrations are added
 * (the old hardcoded list froze at 0068 and broke the MCP integration suite).
 */
export function migrationFilesInOrder(): string[] {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8"),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((e) => `${e.tag}.sql`);
}

/**
 * All migration SQL files in journal apply-order.
 * Computed once at import time from the drizzle journal — the canonical source.
 */
export const MIGRATION_FILES: string[] = migrationFilesInOrder();
