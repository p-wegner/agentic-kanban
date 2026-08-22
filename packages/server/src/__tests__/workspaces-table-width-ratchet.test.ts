// @gate:always-run — asserts a property of the whole migrated SQLite schema; a new column
// arrives via a migration .sql file, which is not in this file's import graph (#739).
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Shrink-only ratchet on the width of `workspaces`, and on its prefix column FAMILIES (#739).
 *
 * `workspaces` has 88 columns. The next widest table in the schema has 23 (`issues`, `repos`)
 * and the median across 44 tables is 9, so this is not "a wide table" — it is ten separate
 * concerns flattened into one row by prefix. Each `latest_*` / `*_cache_*` / `*_gate_*` group
 * is a one-to-many relationship collapsed to its last row: there is exactly one setup run per
 * column set, so history is unrecoverable by construction, and every new field on any of those
 * concerns is another `ALTER TABLE` on the hottest table in the board.
 *
 * #739 verified against the live DB (659 rows) that the twelve columns which are NULL in every
 * row are NOT dead: each one has both a real writer and a real reader in the code, and is NULL
 * only because no row on that instance has reached that state (the `fork_*` and `showdown_*`
 * features are wired end-to-end but unused there). So none of them can be dropped, and the
 * remedy is extraction, not deletion, which #781 sequences family by family.
 *
 * Until that extraction lands, this test is the thing that keeps the problem from getting
 * worse. Both assertions test EQUALITY, not an upper bound: adding column 89 fails, and so
 * does REMOVING one without lowering the number here, so the budgets cannot rot into a
 * permanent exemption that no longer describes the schema.
 */

/** Total column count of every table wide enough to be worth governing. */
const WIDE_TABLE_BUDGETS: Record<string, number> = {
  // The god table itself. Do not raise this. A new field on one of the families below
  // belongs in that family's own table, keyed by workspace_id.
  workspaces: 88,
};

/**
 * Any table at or above this width must appear in WIDE_TABLE_BUDGETS, so a SECOND god
 * table cannot appear unnoticed. Set above the current runner-up (23) on purpose: tables
 * in the 20s are not the problem this ratchet exists for.
 */
const GOVERNED_WIDTH_THRESHOLD = 30;

/**
 * The ten concerns flattened into `workspaces`, with their exact current column counts.
 * A new column in one of these families is exactly the change this ratchet exists to
 * stop — extract the family to `workspace_<concern>` instead of widening the god table.
 */
const COLUMN_FAMILIES: Record<string, number> = {
  latest_setup_: 8,
  latest_symlink_: 8,
  merge_backoff_: 7,
  merge_gate_: 5,
  summary_: 5,
  diff_stat_cache_: 5,
  review_preflight_: 4,
  conflict_cache_: 3,
  scorecard_: 3,
  fork_: 3,
  showdown_: 2,
  code_metrics_: 2,
};

async function tableWidths(): Promise<Map<string, string[]>> {
  const { client } = createTestDb();
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
  );
  const widths = new Map<string, string[]>();
  for (const row of tables.rows) {
    const name = String(row[0]);
    const info = await client.execute(`PRAGMA table_info(${JSON.stringify(name)})`);
    widths.set(name, info.rows.map((r) => String((r as unknown as { name: string }).name)));
  }
  return widths;
}

describe("workspaces column-count ratchet (#739)", () => {
  it("no governed table has gained or lost a column without updating its budget", async () => {
    const widths = await tableWidths();

    // Sanity: the pragma walk actually saw the schema. Without this the checks below
    // could pass vacuously on an empty map.
    expect(widths.size).toBeGreaterThan(30);

    const actual: Record<string, number> = {};
    for (const [table, budget] of Object.entries(WIDE_TABLE_BUDGETS)) {
      const cols = widths.get(table);
      expect(cols, `governed table ${table} is missing from the schema`).toBeDefined();
      actual[table] = cols!.length;
      void budget;
    }
    expect(actual).toEqual(WIDE_TABLE_BUDGETS);
  });

  it("no ungoverned table has grown into a second god table", async () => {
    const widths = await tableWidths();
    const overThreshold = [...widths.entries()]
      .filter(([table, cols]) => cols.length >= GOVERNED_WIDTH_THRESHOLD && !(table in WIDE_TABLE_BUDGETS))
      .map(([table, cols]) => `${table} (${cols.length} columns)`)
      .sort();
    expect(overThreshold).toEqual([]);
  });

  it("no column family in workspaces has grown", async () => {
    const widths = await tableWidths();
    const cols = widths.get("workspaces");
    expect(cols).toBeDefined();

    const counted: Record<string, number> = {};
    for (const prefix of Object.keys(COLUMN_FAMILIES)) {
      counted[prefix] = cols!.filter((c) => c.startsWith(prefix)).length;
    }
    // Equality, so a family that shrinks (because it was extracted) also forces this
    // list to be updated rather than leaving a stale, over-generous budget behind.
    expect(counted).toEqual(COLUMN_FAMILIES);
  });
});
