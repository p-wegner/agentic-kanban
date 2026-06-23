import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  alignForeignKeyActions,
  rewriteTableDdlWithForeignKeys,
} from "@agentic-kanban/shared/lib/fk-actions-repair";
import {
  readForeignKeyActions,
  expectedForeignKeyActions,
  diffForeignKeyActions,
} from "@agentic-kanban/shared/lib/fk-actions";

/**
 * #881 FK-action repair. Builds a DELIBERATELY drifted DB — `issue_dependencies`
 * created with the OLD (no-cascade) FK that #858 found in the wild — and proves the
 * repair rebuilds it to the schema's cascade behaviour without losing data.
 */

/** Minimal subset of the real schema with the drift baked into issue_dependencies. */
async function makeDriftedDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute(
    "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE `project_statuses` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `title` text NOT NULL)",
  );
  // The DRIFT: no ON DELETE cascade (NO ACTION). This is what an old live DB had.
  await client.execute(
    "CREATE TABLE `issue_dependencies` (" +
      "`id` text PRIMARY KEY NOT NULL, " +
      "`issue_id` text NOT NULL, " +
      "`depends_on_id` text NOT NULL, " +
      "`type` text DEFAULT 'depends_on' NOT NULL, " +
      "`created_at` text NOT NULL, " +
      "FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`), " +
      "FOREIGN KEY (`depends_on_id`) REFERENCES `issues`(`id`))",
  );
  await client.execute(
    "CREATE UNIQUE INDEX `issue_dependencies_unique` ON `issue_dependencies` (`issue_id`, `depends_on_id`, `type`)",
  );
  return client;
}

describe("rewriteTableDdlWithForeignKeys", () => {
  it("replaces the FK clauses while preserving columns verbatim", () => {
    const live =
      "CREATE TABLE `issue_dependencies` (\n" +
      "  `id` text PRIMARY KEY NOT NULL,\n" +
      "  `issue_id` text NOT NULL,\n" +
      "  `type` text DEFAULT 'depends_on' NOT NULL,\n" +
      "  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`)\n" +
      ")";
    const out = rewriteTableDdlWithForeignKeys(live, "issue_dependencies", "tmp", [
      { columns: ["issue_id"], refTable: "issues", refColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
    ]);
    expect(out).toContain('CREATE TABLE "tmp"');
    expect(out).toContain("`id` text PRIMARY KEY NOT NULL");
    expect(out).toContain("`type` text DEFAULT 'depends_on' NOT NULL");
    expect(out).toContain('ON DELETE CASCADE');
    // The original (no-cascade) FK clause is gone.
    expect(out.match(/FOREIGN KEY/g)?.length).toBe(1);
  });

  it("does not split a comma inside a REFERENCES column list", () => {
    const live =
      "CREATE TABLE `t` (`a` text, `b` text, FOREIGN KEY (`a`, `b`) REFERENCES `r`(`x`, `y`))";
    const out = rewriteTableDdlWithForeignKeys(live, "t", "t__new", [
      { columns: ["a", "b"], refTable: "r", refColumns: ["x", "y"], onDelete: "set null", onUpdate: "no action" },
    ]);
    expect(out).toContain("`a` text");
    expect(out).toContain("`b` text");
    expect(out).toContain('FOREIGN KEY ("a", "b") REFERENCES "r" ("x", "y")');
    expect(out).toContain("ON DELETE SET NULL");
  });
});

describe("alignForeignKeyActions", () => {
  it("detects FK-action drift on a legacy DB", async () => {
    const client = await makeDriftedDb();
    const report = await alignForeignKeyActions(client, { dryRun: true });
    expect(report.driftedTables).toContain("issue_dependencies");
    const fields = report.mismatches.filter((m) => m.table === "issue_dependencies");
    expect(fields.every((m) => m.field === "onDelete")).toBe(true);
    expect(fields.every((m) => m.expected === "cascade" && m.actual === "no action")).toBe(true);
    client.close();
  });

  it("rebuilds drifted tables to the schema's cascade behaviour, preserving rows", async () => {
    const client = await makeDriftedDb();
    await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'P')");
    await client.execute("INSERT INTO issues (id, title) VALUES ('i1', 'A'), ('i2', 'B')");
    await client.execute(
      "INSERT INTO issue_dependencies (id, issue_id, depends_on_id, type, created_at) " +
        "VALUES ('d1', 'i1', 'i2', 'depends_on', '2026-01-01')",
    );

    const report = await alignForeignKeyActions(client);
    expect(report.rebuiltTables).toContain("issue_dependencies");

    // Row survived the rebuild.
    const rows = await client.execute("SELECT id, issue_id, type FROM issue_dependencies");
    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { id: string }).id).toBe("d1");

    // Index survived.
    const idx = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='issue_dependencies_unique'",
    );
    expect(idx.rows.length).toBe(1);

    // FK actions now match the schema.
    const expected = expectedForeignKeyActions();
    const actual = await readForeignKeyActions(client, ["issue_dependencies"]);
    const depExpected = new Map([["issue_dependencies", expected.get("issue_dependencies")!]]);
    expect(diffForeignKeyActions(depExpected, actual)).toEqual([]);

    // And the cascade actually fires now.
    await client.execute("PRAGMA foreign_keys=ON");
    await client.execute("DELETE FROM issues WHERE id='i1'");
    const after = await client.execute("SELECT id FROM issue_dependencies");
    expect(after.rows.length).toBe(0);

    client.close();
  });

  it("is idempotent — a second run finds no drift", async () => {
    const client = await makeDriftedDb();
    await alignForeignKeyActions(client);
    const second = await alignForeignKeyActions(client);
    expect(second.driftedTables).toEqual([]);
    expect(second.rebuiltTables).toEqual([]);
    client.close();
  });
});
