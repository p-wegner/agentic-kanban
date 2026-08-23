// @gate:always-run — asserts a property of the whole migrated SQLite schema; a new column
// arrives via a migration .sql file, which is not in this file's import graph (#739).
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Shrink-only ratchet on the width of `workspaces`, and on its prefix column FAMILIES (#739).
 *
 * `workspaces` has 38 columns (88 before #781 extracted the first family; #798 took it from
 * 81 to 77 to 75 to 67, and #815 to 62 to 59 to 51 to 46 to 41 to 38). The next widest
 * table in the schema has 23 (`issues`, `repos`) and the median across 44 tables is 9, so this
 * is not "a wide table" — it WAS ten separate concerns flattened into one row by
 * prefix, of which one is left. Each `latest_*` / `*_cache_*` / `*_gate_*` group
 * is a one-to-many relationship collapsed to its last row: there is exactly one setup run per
 * column set, so history is unrecoverable by construction, and every new field on any of those
 * concerns is another `ALTER TABLE` on the hottest table in the board.
 *
 * #739 verified against the live DB (659 rows) that the twelve columns which are NULL in every
 * row are NOT dead: each one has both a real writer and a real reader in the code, and is NULL
 * only because no row on that instance has reached that state (the `fork_*` and `showdown_*`
 * features are wired end-to-end but unused there). So none of them can be dropped, and the
 * remedy is extraction, not deletion, which #781 sequences family by family and #798 carries on.
 *
 * Until that extraction finishes, this test is the thing that keeps the problem from getting
 * worse. Both assertions test EQUALITY, not an upper bound: adding column 82 fails, and so
 * does REMOVING one without lowering the number here, so the budgets cannot rot into a
 * permanent exemption that no longer describes the schema. #781 lowered 88 → 81 and dropped
 * the `merge_backoff_` entry; #798 lowered 81 → 67 and dropped `review_preflight_`,
 * `code_metrics_` and `latest_symlink_`; #815 lowered 67 → 62 → 59 → 51 → 46 → 41 → 38 and
 * dropped `merge_gate_`, `conflict_cache_`, `latest_setup_`, `summary_`, `diff_stat_cache_`
 * and `scorecard_`. That is exactly the shape a successful extraction takes.
 */

/** Total column count of every table wide enough to be worth governing. */
const WIDE_TABLE_BUDGETS: Record<string, number> = {
  // The god table itself. Do not raise this. A new field on one of the families below
  // belongs in that family's own table, keyed by workspace_id.
  workspaces: 38,
};

/**
 * Any table at or above this width must appear in WIDE_TABLE_BUDGETS, so a SECOND god
 * table cannot appear unnoticed. Set above the current runner-up (23) on purpose: tables
 * in the 20s are not the problem this ratchet exists for.
 */
const GOVERNED_WIDTH_THRESHOLD = 30;

/**
 * The concerns still flattened into `workspaces`, with their exact current column counts.
 * A new column in one of these families is exactly the change this ratchet exists to
 * stop — extract the family to `workspace_<concern>` instead of widening the god table.
 *
 * `merge_backoff_` (7), `review_preflight_` (4), `code_metrics_` (2), `latest_symlink_`
 * (8), `merge_gate_` (5), `conflict_cache_` (3), `latest_setup_` (8), `summary_` (5),
 * `diff_stat_cache_` (5) and `scorecard_` (3) are
 * deliberately ABSENT, not zeroed: #781 extracted the first to `workspace_merge_backoff`,
 * #798 the next three to `workspace_review_preflight`, `workspace_code_metrics` and
 * `workspace_symlink_run`, and #815 the last six to `workspace_merge_gate`,
 * `workspace_conflict_cache`, `workspace_setup_run`, `workspace_summary`,
 * `workspace_diff_stat_cache` and `workspace_scorecard`. There is no such
 * prefix on this table any more, and an entry of 0 would be a claim about a family that no
 * longer exists here. Removal is now ENFORCED rather than a convention: the third assertion
 * below fails any declared family that matches zero live columns (#830). Until that landed,
 * the family assertion compared COUNTS only, so a leftover entry of `0` passed and read to a
 * future maintainer as "this family still exists and is empty" — the same stale-baseline
 * shape as #483, and the reason `status-write-ratchet.test.ts` grew its own staleness half.
 * The counts were RE-DERIVED per family at cut time, and the published estimates were wrong
 * in both directions (#798 and #815) — `merge_gate_` was listed at ~7 files and is 4,
 * `conflict_cache_` at 11 and is 5, `latest_setup_` at 10 and is 8; `summary_` was published
 * at 5 and held; `diff_stat_cache_` was published at 10 and is 13, the first UNDER-statement,
 * because `workspace-diff.service.ts` and two test seeders read the columns off a
 * `select()`-everything row that no grep on the table name can see; `scorecard_` was published
 * at 9 and held at 9, because that grep was run WITH the full-row lesson already learned.
 * NOTHING is queued any more. `fork_` and `showdown_` are permanently out
 * of scope — both index-encumbered and all-NULL on this instance, so no local data can prove
 * a backfill — so this is where the #781/#798/#815 extraction sequence ends.
 */
const COLUMN_FAMILIES: Record<string, number> = {
  fork_: 3,
  showdown_: 2,
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

  // The staleness half (#830). The assertion above compares counts, so it catches a family
  // that GROWS and one that SHRINKS to a non-zero number — but a family declared at exactly
  // `0` matches its own live count of 0 and passes forever. That is precisely the state an
  // extracted family is left in if its entry is zeroed instead of deleted, and ten families
  // have now been extracted through this ratchet relying on nothing but an agent reading the
  // convention above. A prefix that matches nothing is either an extraction whose bookkeeping
  // was left half-done or a typo, and neither should pass.
  it("no declared column family is stale (remove the entry once it is extracted)", async () => {
    const widths = await tableWidths();
    const cols = widths.get("workspaces");
    expect(cols).toBeDefined();

    const stale = Object.keys(COLUMN_FAMILIES)
      .filter((prefix) => cols!.every((c) => !c.startsWith(prefix)))
      .map((prefix) => `${prefix}: declared, but no column on \`workspaces\` starts with it — remove the entry`)
      .sort();

    expect(
      stale,
      "Stale COLUMN_FAMILIES entries (an extracted family is DELETED, not zeroed): " + stale.join("; "),
    ).toEqual([]);
  });
});
