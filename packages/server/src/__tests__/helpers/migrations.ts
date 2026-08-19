/**
 * Migration source for the server test suite (#562).
 *
 * Was a hand-written journal read + path expression; now a thin re-export so the server
 * tests, the mcp-server tests and production all agree on where migrations live and what
 * order they apply in. The old comment noted a hardcoded list that "froze at 0068 and broke
 * the MCP integration suite" — deriving from the journal is what fixed that, and sharing the
 * derivation is what keeps the two test helpers from diverging again.
 */
export {
  MIGRATIONS_DIR,
  migrationFilesInOrder,
  readMigrationJournal,
  splitMigrationStatements,
  readMigrationStatements,
} from "@agentic-kanban/shared/lib/migration-source";

import { migrationFilesInOrder } from "@agentic-kanban/shared/lib/migration-source";

/**
 * All migration SQL files in journal apply-order.
 * Computed once at import time from the drizzle journal — the canonical source.
 */
export const MIGRATION_FILES: string[] = migrationFilesInOrder();
