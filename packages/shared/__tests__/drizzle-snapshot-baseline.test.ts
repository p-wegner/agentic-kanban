// @gate:always-run — reads MIGRATIONS_DIR (the journal + meta/ snapshots); reachable by no single-file diff.
/**
 * The drizzle snapshot baseline tracks the newest migration (#789).
 *
 * `drizzle-kit generate` produces a migration by diffing the current schema against the
 * NEWEST snapshot in `drizzle/meta/`. That chain had silently stopped at `0006_snapshot.json`
 * while the journal grew to 133 entries — so for ~126 migrations the nominal tool was
 * unusable, every migration was hand-written, and the Drizzle schema and the migration SQL
 * became two independent hand-maintained descriptions of the same database. Nothing failed;
 * that is exactly why it rotted for two years.
 *
 * #789 re-baselined: a single fresh snapshot regenerated FROM THE SCHEMA, named for the
 * newest journal entry, chained (`prevId`) onto `0006_snapshot.json`. The 0007..0131 gap is
 * left as a gap on purpose — fabricating a back-history of snapshots would be a claim about
 * what those migrations did that nobody can verify. The committed SQL is the history.
 *
 * This guard is the half that keeps it from happening again. It asserts:
 *
 *  1. the newest journal entry has a matching `meta/<idx>_snapshot.json` — so adding a
 *     migration without refreshing the baseline fails here instead of silently disarming
 *     `generate` again;
 *  2. the snapshot chain has no `prevId` collision — the exact error drizzle-kit itself
 *     raises ("are pointing to a parent snapshot ... which is a collision") and refuses to
 *     run on, which would make `generate` unusable in a different way;
 *  3. the newest snapshot's TABLE + COLUMN set equals the Drizzle schema's — so a schema
 *     change that lands with a hand-written migration and a stale snapshot fails too.
 *
 * (3) is deliberately not a full DDL diff. Verified while re-baselining: the schema and a DB
 * built from all 133 migrations agree exactly on tables and columns, and diverge only in
 * objects the schema never declared (8 hand-written perf indexes, 2 FKs, one SQL-side
 * DEFAULT that the schema expresses as `$defaultFn`). Those live in the DB by design;
 * asserting on them here would be noise. Column/table parity against the migrated DB is the
 * job of `packages/server/src/__tests__/migration-schema-drift.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { MIGRATIONS_DIR, readMigrationJournal } from "../src/lib/migration-source.js";
import * as schema from "../src/schema/index.js";

const META_DIR = resolve(MIGRATIONS_DIR, "meta");

interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, { name: string; columns: Record<string, { name: string }> }>;
}

function snapshotFiles(): { idx: number; file: string }[] {
  return readdirSync(META_DIR)
    .map((name) => /^(\d+)_snapshot\.json$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ idx: Number(m[1]), file: m[0] }))
    .sort((a, b) => a.idx - b.idx);
}

function readSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(resolve(META_DIR, file), "utf-8")) as Snapshot;
}

/** Table name -> sorted column names, as the Drizzle schema declares them. */
function schemaTables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value as SQLiteTable);
    out.set(
      config.name,
      config.columns.map((c) => c.name).sort(),
    );
  }
  return out;
}

describe("drizzle snapshot baseline", () => {
  it("the newest journal entry has a matching snapshot", () => {
    const entries = readMigrationJournal(MIGRATIONS_DIR);
    const newest = entries[entries.length - 1];
    const expectedFile = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
    expect(
      existsSync(resolve(META_DIR, expectedFile)),
      `drizzle-kit generate diffs the schema against the NEWEST snapshot. Journal entry ${newest.idx} ` +
        `(${newest.tag}) has no ${expectedFile}, so generate would diff against an older schema and ` +
        `emit a wrong migration. Re-baseline: regenerate the snapshot from the schema into an EMPTY ` +
        `out dir, copy it in as ${expectedFile}, and set its "prevId" to the id of the previous ` +
        `snapshot in meta/. See #789 and packages/shared/CLAUDE.md § "drizzle-kit generate".`,
    ).toBe(true);
  });

  it("the snapshot chain has no prevId collision", () => {
    const seen = new Map<string, string>();
    for (const { file } of snapshotFiles()) {
      const snap = readSnapshot(file);
      const clash = seen.get(snap.prevId);
      expect(
        clash,
        `${file} and ${clash} both declare prevId ${snap.prevId}. drizzle-kit refuses to run on a ` +
          `forked chain ("are pointing to a parent snapshot ... which is a collision"), so generate ` +
          `would be unusable. A re-baselined snapshot must chain onto the previous snapshot's id.`,
      ).toBeUndefined();
      seen.set(snap.prevId, file);
    }
  });

  it("the newest snapshot's tables and columns match the Drizzle schema", () => {
    const files = snapshotFiles();
    const newest = files[files.length - 1];
    const snap = readSnapshot(newest.file);

    const fromSnapshot = new Map<string, string[]>(
      Object.values(snap.tables).map((t) => [t.name, Object.values(t.columns).map((c) => c.name).sort()]),
    );
    const fromSchema = schemaTables();

    const hint =
      `The newest snapshot (${newest.file}) no longer describes the Drizzle schema, so ` +
      `drizzle-kit generate would emit a migration for changes that are already applied. ` +
      `Regenerate the baseline (see packages/shared/CLAUDE.md § "drizzle-kit generate", #789).`;

    expect([...fromSnapshot.keys()].sort(), `Tables differ. ${hint}`).toEqual([...fromSchema.keys()].sort());
    for (const [table, columns] of fromSchema) {
      expect(fromSnapshot.get(table), `Columns of "${table}" differ. ${hint}`).toEqual(columns);
    }
  });
});
