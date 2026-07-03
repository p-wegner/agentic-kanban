/**
 * db:migrate — apply pending migrations using the hardened in-house migrator.
 *
 * Why not `drizzle-kit migrate`? On non-LTS Node (23.x+) the libsql@0.4.7 native
 * binding misreports `SQLITE_OK` (rc 0 = success) as a thrown error on the first
 * `CREATE TABLE IF NOT EXISTS`, which makes drizzle-kit's CLI migrator (and
 * drizzle-orm's `migrate()`) abort having applied ZERO migrations — leaving a
 * half-baked db that makes `db:seed` fail with "no such table". `applyMigrations`
 * (db/manual-migrate.ts) ignores that spurious error per-statement and continues,
 * which is the same path the server uses on startup. This keeps `pnpm db:setup`
 * working regardless of Node version. See docs and the manual-migrate header.
 */
import { runMigrations } from "../db/manual-migrate.js";

runMigrations()
  .then(() => {
    console.log("[db:migrate] migrations applied.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[db:migrate] failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
