import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getMigrationsFolder(): string {
  // In bundled/published mode, migrations are adjacent to the JS file in ./migrations/
  const published = resolve(__dirname, "./migrations");
  // In dev mode, they're in ../../shared/drizzle from src/ (or dist/)
  const dev = resolve(__dirname, "../../../shared/drizzle");
  try {
    if (existsSync(resolve(published, "meta/_journal.json"))) return published;
  } catch { /* ignore */ }
  return dev;
}

/**
 * Apply migrations manually using the raw libsql client.
 *
 * Works around a libsql@0.4.7 + Node.js 26 bug where CREATE TABLE IF NOT EXISTS
 * returns SQLITE_OK (0), which libsql misinterprets as an error, causing
 * drizzle-orm's migrate() to abort partway through.
 */
export async function applyMigrations(client: Client): Promise<void> {
  const folder = getMigrationsFolder();
  const journalPath = resolve(folder, "meta/_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal not found at ${journalPath}`);
  }

  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entries: Array<{ tag: string; when: number; breakpoints: boolean }> = journal.entries;

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
    appliedTags = new Set(result.rows.map((r: any) => String(r.hash)));
  } catch { /* table doesn't exist yet */ }

  let anyApplied = false;

  for (let i = 0; i < entries.length; i++) {
    if (appliedTags.has(entries[i].tag)) continue;

    const sqlFile = resolve(folder, `${entries[i].tag}.sql`);
    if (!existsSync(sqlFile)) continue;

    const sql = readFileSync(sqlFile, "utf8");

    // Split on statement breakpoints
    const statements = entries[i].breakpoints
      ? sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)
      : [sql.trim()];

    for (const stmt of statements) {
      try {
        await client.execute(stmt);
      } catch (err: any) {
        // Ignore spurious SQLITE_OK "not an error" from libsql
        if (err?.code === "SQLITE_OK" || (err?.message?.includes?.("not an error"))) {
          continue;
        }
        // Ignore "duplicate column name" / "table already exists" — migration already applied
        if (err?.message?.includes?.("duplicate column name") || err?.message?.includes?.("already exists")) {
          continue;
        }
        throw err;
      }
    }

    // Record migration as applied (use tag as hash to match drizzle-kit format)
    try {
      await client.execute({
        sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        args: [entries[i].tag, entries[i].when],
      });
    } catch {
      // May already exist (drizzle-kit may have inserted it)
    }
  }
}
