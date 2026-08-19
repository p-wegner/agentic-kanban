/**
 * Where the drizzle migrations live, and how to read them (#562).
 *
 * NODE-ONLY (`node:fs`, `node:path`) — import via the deep path
 * `@agentic-kanban/shared/lib/migration-source`, never through the client-reachable barrel.
 *
 * Two facts about the migration set were written out independently in nine places: the
 * DIRECTORY (four hand-built path expressions in production, plus three in test helpers) and
 * the STATEMENT SPLIT on `--> statement-breakpoint` (six copies). Both had already cost
 * something:
 *
 * - The published CLI broke once when its bundle entry moved to `dist/cli/index.js` and a
 *   hardcoded `./migrations` resolved to a directory that did not exist. The fix — probe
 *   candidates and take the one that actually has a journal — then lived in ONE of the four
 *   copies (`db/manual-migrate.ts`); `db/migrations.ts` kept the older two-candidate version
 *   and simply went dead without anyone noticing.
 * - `mcp-server`'s test helper was a byte-for-byte fork of the server's that had not picked
 *   up the #471 client-close fix.
 *
 * Deliberately NOT here: the async transactional runner in `manual-migrate.ts`. It applies
 * migrations to a live DB with an idempotency shim and a `__drizzle_migrations` ledger; the
 * test appliers are synchronous, ledger-free, and run against a fresh in-memory DB. They
 * differ on purpose (the ticket says so too), so only the SOURCE-reading is shared.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path (relative to the repo root) of the drizzle migrations directory. */
export const DRIZZLE_DIR_RELATIVE = "packages/shared/drizzle";
/** Path (relative to the repo root) of the drizzle migration journal. */
export const JOURNAL_RELATIVE = `${DRIZZLE_DIR_RELATIVE}/meta/_journal.json`;
/** The journal's filename within a migrations directory. */
export const JOURNAL_IN_DIR = "meta/_journal.json";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

/**
 * The first candidate directory that actually contains a journal.
 *
 * The candidate ORDER is the load-bearing part, and it is why this is probing rather than a
 * constant: a flat bundle finds migrations at `./migrations`, a nested bundle at
 * `../migrations`, and a dev/monorepo run at the shared drizzle dir. Returns the last
 * candidate when none has a journal, so the caller's error names the dev path — the one a
 * human can act on.
 */
export function resolveMigrationsDir(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      if (existsSync(resolve(candidate, JOURNAL_IN_DIR))) return candidate;
    } catch { /* an unreadable candidate is simply not the one */ }
  }
  return candidates[candidates.length - 1];
}

/**
 * The migrations directory as seen from THIS module (the monorepo's shared package), which
 * is what every test helper wants. Production entry points build their own candidate list
 * and call `resolveMigrationsDir`, because their bundle layout is not this one.
 */
export const MIGRATIONS_DIR = resolve(__dirname, "../../drizzle");

/** Parsed journal entries in APPLY order — which is not lexical (0023 can precede 0020). */
export function readMigrationJournal(migrationsDir: string = MIGRATIONS_DIR): JournalEntry[] {
  const raw = readFileSync(resolve(migrationsDir, JOURNAL_IN_DIR), "utf-8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** Migration filenames (`0001_foo.sql`) in apply order. */
export function migrationFilesInOrder(migrationsDir: string = MIGRATIONS_DIR): string[] {
  return readMigrationJournal(migrationsDir).map((e) => `${e.tag}.sql`);
}

/**
 * Split one migration file into executable statements.
 *
 * `breakpoints` comes from the journal entry and defaults to true, because that is what
 * drizzle emits and what all six hand-written copies assumed. When it is false the file is a
 * single statement — splitting it anyway would corrupt a migration containing the marker
 * inside a string literal.
 */
export function splitMigrationStatements(sql: string, breakpoints = true): string[] {
  if (!breakpoints) {
    const trimmed = sql.trim();
    return trimmed ? [trimmed] : [];
  }
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read one migration file's statements, in order. */
export function readMigrationStatements(
  file: string,
  migrationsDir: string = MIGRATIONS_DIR,
  breakpoints = true,
): string[] {
  return splitMigrationStatements(readFileSync(resolve(migrationsDir, file), "utf-8"), breakpoints);
}
