import { describe, expect, it, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { findRenamedSiblingTag } from "../db/manual-migrate.js";

/**
 * #825 — the rename diagnostic.
 *
 * `applyMigrations` decides applied-ness by tag STRING. Renaming a `.sql` after it has already
 * run locally therefore makes an applied migration look pending, and re-running its DDL fails
 * with `table ... already exists` on that boot and every boot after it. This happened to the
 * dev board: `__drizzle_migrations` held `0140_mature_firebird` (drizzle-kit's generated name)
 * while the journal had been renamed to `0140_workspace_setup_run` before the commit.
 *
 * The fix does not tolerate the failure — tolerating `already exists` on a modern migration
 * would mask genuinely non-idempotent DDL, which is what `LEGACY_IDEMPOTENCY_CUTOFF_IDX`
 * exists to keep visible. It only names the cause, and this suite pins the lookup that lets it.
 */
const clients: Client[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function dbWithApplied(tags: string[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await client.execute(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const tag of tags) {
    await client.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [tag, 1],
    });
  }
  return client;
}

describe("migration rename diagnostic (#825)", () => {
  it("finds an applied migration that shares the index but not the name — the live failure", async () => {
    const client = await dbWithApplied(["0139_workspace_conflict_cache", "0140_mature_firebird"]);
    await expect(findRenamedSiblingTag(client, "0140_workspace_setup_run")).resolves.toBe(
      "0140_mature_firebird",
    );
  });

  it("does not fire when the SAME tag is what is recorded", async () => {
    // The ordinary pending case: nothing at this index is applied under any other name.
    const client = await dbWithApplied(["0139_workspace_conflict_cache"]);
    await expect(findRenamedSiblingTag(client, "0140_workspace_setup_run")).resolves.toBeNull();
  });

  it("does not confuse a NEIGHBOURING index for a rename", async () => {
    const client = await dbWithApplied(["0141_something_else", "0014_old"]);
    await expect(findRenamedSiblingTag(client, "0140_workspace_setup_run")).resolves.toBeNull();
  });

  it("does not match a LONGER index — the SQL `LIKE` wildcard trap", async () => {
    // The first version asked for `hash LIKE '0140_%'`. In SQL LIKE, `_` matches any single
    // character, so that pattern also accepts `01405_...` and the diagnostic would have
    // pointed at an unrelated migration. The lookup compares parsed indices instead.
    const client = await dbWithApplied(["01405_five_digit_index"]);
    await expect(findRenamedSiblingTag(client, "0140_workspace_setup_run")).resolves.toBeNull();
  });

  it("reports nothing rather than throwing when the tracking table is absent", async () => {
    // A fresh DB has no `__drizzle_migrations` yet. The diagnostic is best-effort: it must
    // never replace the real migration error with an error of its own.
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await expect(findRenamedSiblingTag(client, "0140_workspace_setup_run")).resolves.toBeNull();
  });

  it("returns null for a tag with no numeric index", async () => {
    const client = await dbWithApplied(["0140_mature_firebird"]);
    await expect(findRenamedSiblingTag(client, "not_a_numbered_tag")).resolves.toBeNull();
  });
});
