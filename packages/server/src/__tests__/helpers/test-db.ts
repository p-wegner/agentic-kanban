import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
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
 * Content hash of every migration .sql file plus the journal, in journal apply-order.
 * Any change to a migration's content, its order, or the addition/removal of a
 * migration changes this hash — which is what keys the template DB below and makes
 * a stale template impossible (#535).
 */
function migrationsContentHash(): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8"));
  for (const file of MIGRATION_FILES) {
    hash.update(file);
    hash.update(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
  return hash.digest("hex").slice(0, 16);
}

let cachedTemplatePath: string | null = null;

/**
 * Path to a fully-migrated template DB, built once per process (lazily, on first
 * call) and reused by every subsequent `createTestDb()` call via `copyFileSync`
 * (#535). Keyed by `migrationsContentHash()` so a template built for an older
 * migration set is never reused across a schema change — the filename itself
 * encodes the content it was built from.
 *
 * Building the template still runs the same `applyMigrationsToClient` used by
 * callers that need a genuine fresh apply (e.g. `migration-schema-drift.test.ts`),
 * so this is pure waste removal: every test still gets an independently-migrated
 * schema, just copied instead of DDL-replayed 121 times over.
 */
function getOrBuildTemplateDb(): string {
  if (cachedTemplatePath && existsSync(cachedTemplatePath)) return cachedTemplatePath;
  const hash = migrationsContentHash();
  const templatePath = join(tmpdir(), `test-db-template-${hash}.db`);
  if (existsSync(templatePath)) {
    cachedTemplatePath = templatePath;
    return templatePath;
  }
  // Build under a unique temp name, then COPY (not rename) into place: libsql's native
  // handle keeps the file briefly locked on Windows even after client.close() (the same
  // quirk #471 works around elsewhere), so a rename right after close intermittently
  // fails with EBUSY. copyFileSync only reads the source, which the OS allows immediately.
  const buildingPath = join(tmpdir(), `test-db-template-building-${randomUUID()}.db`);
  const buildClient = createClient({ url: `file:${buildingPath}` });
  try {
    applyMigrationsToClient(buildClient);
  } finally {
    buildClient.close();
  }
  mkdirSync(tmpdir(), { recursive: true });
  if (!existsSync(templatePath)) {
    // PUBLISH ATOMICALLY. copyFileSync writes the destination in place, so a concurrent
    // worker's existsSync(templatePath) can observe a PARTIALLY-written file and copy a
    // truncated DB into its test database — a corrupt schema surfacing as unrelated,
    // irreproducible failures across the suite. Staging under a unique name and renaming
    // means a reader sees either no file or the complete one; rename is atomic within a
    // volume, and the staged file is a plain copy (no libsql handle), so it has none of
    // the EBUSY problem that rules out renaming `buildingPath` directly.
    const stagedPath = `${templatePath}.staged-${randomUUID()}`;
    try {
      copyFileSync(buildingPath, stagedPath);
      renameSync(stagedPath, templatePath);
    } catch {
      // Another worker won the race and published templatePath first — its bytes are as
      // good as ours (same migration hash). Drop our copy and use theirs.
      try {
        rmSync(stagedPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${buildingPath}${suffix}`, { force: true });
    } catch {
      /* best-effort — a lingering native lock is not worth failing the run over */
    }
  }
  cachedTemplatePath = templatePath;
  return templatePath;
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
 *
 * The schema is produced by copying a pre-migrated template DB (built once per
 * process, keyed by a hash of the migration contents) instead of replaying all
 * 121 migration files on every call — see #535. Callers that need a genuine
 * fresh `applyMigrationsToClient` apply (e.g. to assert migrations themselves
 * don't throw) should call it directly instead of going through this helper.
 */
export function createTestDb() {
  registerExitCleanup();
  const templatePath = getOrBuildTemplateDb();
  const file = join(tmpdir(), `test-db-${randomUUID()}.db`);
  createdTempDbFiles.push(file);
  copyFileSync(templatePath, file);
  const client = createClient({ url: `file:${file}` });
  // Tracked so the fork closes it at exit even when the caller never disposes (#471).
  createdClients.push(client);
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
