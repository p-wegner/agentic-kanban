import { describe, it, expect, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  assertForeignKeysEnabled,
  alignForeignKeyActionsOnStartup,
} from "../startup/fk-alignment.js";
import {
  readForeignKeyActions,
  expectedForeignKeyActions,
  diffForeignKeyActions,
} from "@agentic-kanban/shared/lib/fk-actions";

/**
 * arch-review #894 — the startup FK-integrity guard.
 *
 * #881 wired `alignForeignKeyActions` ONLY into manual `db:repair`; it never ran on
 * server startup, so a long-lived `kanban.db` could keep RESTRICT/NO-ACTION where the
 * schema says cascade. And `PRAGMA foreign_keys=ON` was swallowed, so a failed pragma
 * silently disabled every ON DELETE clause. These tests pin both fixes.
 */

/** Minimal real-schema subset with the #858 drift baked into issue_dependencies. */
async function makeDriftedDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute(
    "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `title` text NOT NULL)",
  );
  // The DRIFT: no ON DELETE cascade — what an old live DB carried.
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
  return client;
}

describe("assertForeignKeysEnabled", () => {
  it("passes when PRAGMA foreign_keys=ON took effect", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys=ON");
    await expect(assertForeignKeysEnabled(client, "read")).resolves.toBeUndefined();
    client.close();
  });

  it("throws LOUD when FK enforcement is off (the swallowed-pragma hole)", async () => {
    const client = createClient({ url: ":memory:" });
    // Simulate the failed/never-applied pragma: enforcement left OFF.
    await client.execute("PRAGMA foreign_keys=OFF");
    await expect(assertForeignKeysEnabled(client, "write")).rejects.toThrow(
      /PRAGMA foreign_keys is OFF on the write connection/,
    );
    client.close();
  });
});

describe("alignForeignKeyActionsOnStartup", () => {
  it("repairs FK-action drift on a legacy live DB at startup", async () => {
    const client = await makeDriftedDb();
    await client.execute("INSERT INTO issues (id, title) VALUES ('i1', 'A'), ('i2', 'B')");
    await client.execute(
      "INSERT INTO issue_dependencies (id, issue_id, depends_on_id, type, created_at) " +
        "VALUES ('d1', 'i1', 'i2', 'depends_on', '2026-01-01')",
    );

    const result = await alignForeignKeyActionsOnStartup(client);
    expect(result.rebuiltTables).toContain("issue_dependencies");

    // The cascade the schema promises now actually fires on the live DB.
    await client.execute("PRAGMA foreign_keys=ON");
    await client.execute("DELETE FROM issues WHERE id='i1'");
    const after = await client.execute("SELECT id FROM issue_dependencies");
    expect(after.rows.length).toBe(0);

    // And there is no residual action drift.
    const expected = expectedForeignKeyActions();
    const actual = await readForeignKeyActions(client, ["issue_dependencies"]);
    const depExpected = new Map([
      ["issue_dependencies", expected.get("issue_dependencies")!],
    ]);
    expect(diffForeignKeyActions(depExpected, actual)).toEqual([]);
    client.close();
  });

  it("is a silent no-op on a DB whose FK actions already match", async () => {
    const client = await makeDriftedDb();
    await alignForeignKeyActionsOnStartup(client);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = await alignForeignKeyActionsOnStartup(client);
    expect(second.driftedTables).toEqual([]);
    expect(second.rebuiltTables).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    client.close();
  });
});
