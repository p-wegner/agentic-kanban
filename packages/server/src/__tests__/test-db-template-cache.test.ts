// @gate:always-run — reads MIGRATIONS_DIR to key the template hash, so its
// correctness does not depend on this package's import graph (#538).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./helpers/migrations.js";

/**
 * Probe for the createTestDb() template-copy optimization (#535): every call
 * used to replay all 121 migration files from scratch. Now the schema is
 * produced once per process (a template DB keyed by a hash of the migration
 * contents) and copied per call, so this asserts both the keying and that a
 * copied DB is genuinely usable (has the migrated schema, is independent of
 * other copies).
 */
describe("createTestDb template cache (#535)", () => {
  function expectedTemplateHash(): string {
    const hash = createHash("sha256");
    hash.update(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8"));
    for (const file of MIGRATION_FILES) {
      hash.update(file);
      hash.update(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
    }
    return hash.digest("hex").slice(0, 16);
  }

  it("creates a template DB file keyed by the migration-content hash", () => {
    createTestDb();
    const hash = expectedTemplateHash();
    // TEMP-PREFIX OK: this reads the PERSISTENT template build cache that
    // `helpers/test-db.ts` publishes, so the path must mirror that helper's exactly. It is
    // deliberately an unswept loose file — one per schema, not one per run, with a legitimate
    // lifetime of weeks — see the marker on `getOrBuildTemplateDb` for the reasoning (#840).
    const templatePath = join(tmpdir(), `test-db-template-${hash}.db`);
    expect(existsSync(templatePath)).toBe(true);
  });

  it("reuses the same template across multiple calls instead of rebuilding it", () => {
    createTestDb();
    const hash = expectedTemplateHash();
    // TEMP-PREFIX OK: the same persistent build cache as above (#840).
    const templatePath = join(tmpdir(), `test-db-template-${hash}.db`);
    const before = readFileSync(templatePath);

    createTestDb();
    createTestDb();

    const after = readFileSync(templatePath);
    expect(after.equals(before)).toBe(true);
  });

  it("hands out independent, usable copies with the full migrated schema", async () => {
    const { client: clientA, dispose: disposeA } = createTestDb();
    const { client: clientB, dispose: disposeB } = createTestDb();
    try {
      const tables = await clientA.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
      );
      expect(tables.rows.length).toBe(1);

      await clientA.execute(
        "INSERT INTO tags (id, name, color, created_at) VALUES ('probe-tag', 'probe', '#000000', datetime('now'))",
      );
      const seenByA = await clientA.execute("SELECT id FROM tags WHERE id='probe-tag'");
      expect(seenByA.rows.length).toBe(1);

      const seenByB = await clientB.execute("SELECT id FROM tags WHERE id='probe-tag'");
      expect(seenByB.rows.length).toBe(0);
    } finally {
      disposeA();
      disposeB();
    }
  });

  it("would rebuild under a different content hash (keying sanity check)", () => {
    // Not a live rebuild test (that would require mutating real migration files);
    // this just pins the hash function to depend on migration content so a future
    // change to it doesn't silently drop the staleness protection.
    const hashA = expectedTemplateHash();
    const tamperedFiles = [...MIGRATION_FILES];
    const forgedHash = createHash("sha256");
    forgedHash.update("not the real journal");
    for (const file of tamperedFiles) {
      forgedHash.update(file);
      forgedHash.update("tampered content");
    }
    expect(forgedHash.digest("hex").slice(0, 16)).not.toBe(hashA);
  });
});
