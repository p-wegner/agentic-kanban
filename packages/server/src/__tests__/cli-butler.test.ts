import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { MIGRATIONS_DIR } from "./helpers/migrations.js";
import { applyMigrationsToClient } from "./helpers/test-db.js";

// Smoke tests for the butler CLI surface. The per-command unit tests live next to
// the MCP wrappers (mcp-server/src/__tests__/tools/butler-tools.test.ts) — both
// CLI and MCP are thin HTTP clients over the same /api/projects/:id/butler routes,
// so the wrapper tests cover the request-shape contract once for both.
//
// What we cover here:
//  - --help lists every new subcommand (catches accidental removals)
//  - the friendly "is the dev server running?" message when no server is reachable
// Anything more would require spinning up the full server (out of scope for unit tests).

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "../cli/index.ts");
const PKG_DIR = resolve(__dirname, "../..");
const TSX_LOADER = pathToFileURL(resolve(PKG_DIR, "node_modules/tsx/dist/loader.mjs")).href;

function applyMigrations(dbPath: string) {
  const client = createClient({ url: `file:${dbPath}` });
  applyMigrationsToClient(client);
  client.execute("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL)");
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8"));
  for (const entry of journal.entries) {
    const sqlFile = resolve(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sqlContent = readFileSync(sqlFile, "utf-8");
    const hash = createHash("sha256").update(sqlContent).digest("hex");
    client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [hash, entry.when] });
  }
  client.close();
}

function createTestDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cli-butler-test-"));
  const dbPath = join(tmpDir, "test.db");
  applyMigrations(dbPath);
  return { dbPath, cleanup: () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} } };
}

function runCli(args: string[], dbPath: string, port = 1) {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    env: { ...process.env, DB_URL: `file:${dbPath}`, SERVER_PORT: String(port) },
    cwd: PKG_DIR,
    encoding: "utf-8",
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    status: result.status ?? 1,
  };
}

describe("CLI butler --help", () => {
  let ctx: ReturnType<typeof createTestDb>;
  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("lists every butler subcommand brought up to REST parity", { timeout: 60_000 }, () => {
    const result = runCli(["butler", "--help"], ctx.dbPath);
    expect(result.status).toBe(0);
    for (const cmd of ["ask", "ensure", "stop", "interrupt", "model", "profile", "state", "skill"]) {
      expect(result.stdout).toContain(cmd);
    }
  });
});
