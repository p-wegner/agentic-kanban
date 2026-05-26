import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./migrations.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates an in-memory libsql client with all migrations applied.
 * Returns the drizzle `db` instance and the raw `client`.
 */
export function createTestDb() {
  const client = createClient({ url: ":memory:" });
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
  const db = drizzle(client, { schema });
  return { client, db };
}
