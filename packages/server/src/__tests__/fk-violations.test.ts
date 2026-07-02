import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForeignKeyViolations,
  logForeignKeyViolations,
  quarantineAndDeleteFkViolations,
} from "../db/fk-violations.js";

/**
 * #987 — the foreign_key_check sweep. `PRAGMA foreign_keys=ON` is per-connection and
 * only guards NEW writes; rows inserted by a connection without the pragma (ad-hoc
 * scripts) violate FKs invisibly. These tests pin: detection + loud logging (startup),
 * quarantine-then-delete (db:repair), and clean-DB no-op. TEMP databases only.
 */

/** In-memory schema mirroring the live failure: issues → projects FK. */
async function makeDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute(
    "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE `issues` (" +
      "`id` text PRIMARY KEY NOT NULL, " +
      "`project_id` text NOT NULL, " +
      "`title` text NOT NULL, " +
      "FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade)",
  );
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Real project')");
  await client.execute(
    "INSERT INTO issues (id, project_id, title) VALUES ('i1', 'p1', 'Valid issue')",
  );
  return client;
}

/** Insert an orphan the way the bug happened: a connection state with FK checks off. */
async function insertOrphan(client: Client, id = "orphan1", title = "Orphaned issue") {
  await client.execute("PRAGMA foreign_keys=OFF");
  await client.execute({
    sql: "INSERT INTO issues (id, project_id, title) VALUES (?, '3276', ?)",
    args: [id, title],
  });
  await client.execute("PRAGMA foreign_keys=ON");
}

let quarantineDir: string;

beforeEach(() => {
  quarantineDir = mkdtempSync(join(tmpdir(), "fk-quarantine-test-"));
});

afterEach(() => {
  rmSync(quarantineDir, { recursive: true, force: true });
});

describe("checkForeignKeyViolations", () => {
  it("detects pre-existing FK-violating rows with table, parent and a row snippet", async () => {
    const client = await makeDb();
    await insertOrphan(client);

    const violations = await checkForeignKeyViolations(client);
    expect(violations).toHaveLength(1);
    expect(violations[0].table).toBe("issues");
    expect(violations[0].parent).toBe("projects");
    expect(violations[0].rowid).not.toBeNull();
    expect(violations[0].snippet).toContain("Orphaned issue");
    expect(violations[0].snippet).toContain("3276");
    client.close();
  });

  it("survives orphan rows with INVALID UTF-8 in text columns (libsql panic guard)", async () => {
    // The live #987 rows had invalid UTF-8 in `title`; a plain SELECT * makes the
    // libsql native binding panic and ABORT the process. The sweep must read such
    // rows via blob-cast + lenient decode instead of crashing.
    const client = await makeDb();
    await client.execute("PRAGMA foreign_keys=OFF");
    await client.execute(
      "INSERT INTO issues (id, project_id, title) VALUES ('bad1', '3276', CAST(x'80FFC328' AS TEXT))",
    );
    await client.execute("PRAGMA foreign_keys=ON");

    const violations = await checkForeignKeyViolations(client);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("3276");

    const result = await quarantineAndDeleteFkViolations(client, quarantineDir);
    expect(result.deletedRows).toBe(1);
    expect(result.remaining).toBe(0);
    client.close();
  });

  it("returns an empty list on a clean DB", async () => {
    const client = await makeDb();
    expect(await checkForeignKeyViolations(client)).toEqual([]);
    client.close();
  });
});

describe("logForeignKeyViolations (startup path)", () => {
  it("logs each violation loudly via console.error and points at db:repair", async () => {
    const client = await makeDb();
    await insertOrphan(client);
    const violations = await checkForeignKeyViolations(client);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logForeignKeyViolations(violations, "startup");
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("foreign_key_check");
    expect(output).toContain("db:repair");
    expect(output).toContain("issues");
    expect(output).toContain("projects");
    expect(output).toContain("Orphaned issue");
    errSpy.mockRestore();
    client.close();
  });
});

describe("quarantineAndDeleteFkViolations (db:repair path)", () => {
  it("quarantines the full rows to JSON, then deletes only the orphans", async () => {
    const client = await makeDb();
    await insertOrphan(client, "orphan1", "Orphaned A");
    await insertOrphan(client, "orphan2", "Orphaned B");

    const result = await quarantineAndDeleteFkViolations(client, quarantineDir);
    expect(result.violations).toHaveLength(2);
    expect(result.deletedRows).toBe(2);
    expect(result.remaining).toBe(0);

    // Quarantine file exists next to the "DB" and holds the full rows.
    expect(result.quarantinePath).not.toBeNull();
    expect(result.quarantinePath).toContain("kanban-fk-quarantine-");
    const dump = JSON.parse(readFileSync(result.quarantinePath!, "utf8"));
    expect(dump.rows).toHaveLength(2);
    const titles = dump.rows.map((r: { row: { title: string } }) => r.row.title).sort();
    expect(titles).toEqual(["Orphaned A", "Orphaned B"]);
    expect(dump.rows[0].row.project_id).toBe("3276");

    // The orphans are gone; everything else is untouched.
    const left = await client.execute("SELECT id FROM issues ORDER BY id");
    expect(left.rows.map((r) => r.id)).toEqual(["i1"]);
    const projects = await client.execute("SELECT id FROM projects");
    expect(projects.rows).toHaveLength(1);
    expect(await checkForeignKeyViolations(client)).toEqual([]);
    client.close();
  });

  it("is a complete no-op on a clean DB (no quarantine file, no deletes)", async () => {
    const client = await makeDb();
    const result = await quarantineAndDeleteFkViolations(client, quarantineDir);
    expect(result.violations).toEqual([]);
    expect(result.quarantinePath).toBeNull();
    expect(result.deletedRows).toBe(0);
    expect(result.remaining).toBe(0);
    expect(readdirSync(quarantineDir)).toEqual([]);

    const rows = await client.execute("SELECT id FROM issues");
    expect(rows.rows).toHaveLength(1);
    client.close();
  });
});
