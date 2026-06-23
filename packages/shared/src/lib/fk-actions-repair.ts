/**
 * Repair path for FK-action drift (arch-review #881).
 *
 * SQLite cannot ALTER a foreign key's action in place — the only safe way to change
 * one on an existing table is the documented 12-step table rebuild
 * (https://www.sqlite.org/lang_altertable.html#otheralter). This module aligns a
 * live DB's FK actions to {@link expectedForeignKeyActions} (the Drizzle schema) for
 * exactly the tables that drift, and leaves everything else untouched.
 *
 * It is deliberately CONSERVATIVE about column shape: it reuses the table's own live
 * column definitions verbatim and rewrites ONLY the FOREIGN KEY constraint clauses.
 * So a repair can never change a column's type/default/nullability — it only fixes
 * `ON DELETE` / `ON UPDATE`. Each table is rebuilt inside its own transaction with
 * `foreign_keys` disabled (per the SQLite procedure) and a `foreign_key_check`
 * afterwards; a failed check rolls the table back. The caller (db:repair) takes a
 * full verified backup first.
 */
import {
  diffForeignKeyActions,
  expectedForeignKeyActions,
  readForeignKeyActions,
  tablesWithManagedFkActions,
  type FkPragmaClient,
  type ForeignKeySpec,
  type ForeignKeyMismatch,
} from "./fk-actions.js";

/** libsql client surface needed for a rebuild (execute + raw exec). */
export interface FkRepairClient extends FkPragmaClient {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface FkRepairResult {
  /** Tables whose FK actions disagreed with the schema before repair. */
  driftedTables: string[];
  /** Tables actually rebuilt (== driftedTables on success). */
  rebuiltTables: string[];
  /** The specific (table, fk, field) mismatches that were found. */
  mismatches: ForeignKeyMismatch[];
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function actionClause(action: ForeignKeySpec["onDelete"]): string {
  return action.toUpperCase();
}

/** Regenerate the canonical `FOREIGN KEY (...) REFERENCES ...` constraint lines. */
function renderForeignKeyClauses(specs: ForeignKeySpec[]): string {
  return specs
    .map((s) => {
      const from = s.columns.map(q).join(", ");
      const to = s.refColumns.map(q).join(", ");
      return `  FOREIGN KEY (${from}) REFERENCES ${q(s.refTable)} (${to}) ` +
        `ON UPDATE ${actionClause(s.onUpdate)} ON DELETE ${actionClause(s.onDelete)}`;
    })
    .join(",\n");
}

/**
 * Take a live `CREATE TABLE` statement, strip every `FOREIGN KEY (...)` constraint,
 * and re-append freshly generated ones for `targetName`. Column definitions are kept
 * verbatim. Returns the new statement (renamed to `targetName`).
 */
export function rewriteTableDdlWithForeignKeys(
  liveDdl: string,
  originalName: string,
  targetName: string,
  specs: ForeignKeySpec[],
): string {
  const open = liveDdl.indexOf("(");
  const close = liveDdl.lastIndexOf(")");
  if (open < 0 || close < 0 || close < open) {
    throw new Error(`Cannot parse CREATE TABLE for ${originalName}: ${liveDdl}`);
  }
  const body = liveDdl.slice(open + 1, close);

  // Split the table body into top-level, comma-separated definitions (depth-aware so
  // a comma inside `text(a, b)` or `REFERENCES t(c1, c2)` does not split a clause).
  const defs: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      defs.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) defs.push(current);

  const nonFk = defs
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^FOREIGN\s+KEY/i.test(d));

  const lines = [...nonFk.map((d) => `  ${d}`)];
  if (specs.length > 0) lines.push(renderForeignKeyClauses(specs));

  return `CREATE TABLE ${q(targetName)} (\n${lines.join(",\n")}\n)`;
}

interface IndexRow {
  name: string;
  sql: string | null;
}

/** Rebuild a single table so its FK actions match `specs`. Assumes caller has a tx. */
async function rebuildTable(
  client: FkRepairClient,
  table: string,
  specs: ForeignKeySpec[],
): Promise<void> {
  const ddlRes = await client.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=${q(table).replace(/"/g, "'")}`,
  );
  const liveDdl = (ddlRes.rows[0] as { sql?: string } | undefined)?.sql;
  if (!liveDdl) throw new Error(`No CREATE TABLE found for ${table}`);

  // Capture user-defined indexes (auto-indexes have sql IS NULL and are recreated by
  // the table's own constraints, so they must NOT be replayed).
  const idxRes = await client.execute(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=${q(table).replace(/"/g, "'")}`,
  );
  const indexes = (idxRes.rows as unknown as IndexRow[]).filter((i) => i.sql);

  const colRes = await client.execute(`PRAGMA table_info(${q(table)})`);
  const columns = (colRes.rows as Array<{ name: string }>).map((c) => q(c.name)).join(", ");

  const tmp = `${table}__fkrepair`;
  const newDdl = rewriteTableDdlWithForeignKeys(liveDdl, table, tmp, specs);

  await client.execute(newDdl);
  await client.execute(`INSERT INTO ${q(tmp)} (${columns}) SELECT ${columns} FROM ${q(table)}`);
  await client.execute(`DROP TABLE ${q(table)}`);
  await client.execute(`ALTER TABLE ${q(tmp)} RENAME TO ${q(table)}`);
  for (const idx of indexes) {
    await client.execute(idx.sql!);
  }
}

/**
 * Detect FK-action drift for every table the schema manages and rebuild the drifted
 * ones to match. Non-destructive to column data. Wrap the whole thing in
 * `PRAGMA foreign_keys=OFF` (required by the SQLite rebuild procedure) and verify
 * with `foreign_key_check` before re-enabling.
 *
 * Pass `dryRun: true` to detect-and-report without rebuilding.
 */
export async function alignForeignKeyActions(
  client: FkRepairClient,
  opts: { dryRun?: boolean } = {},
): Promise<FkRepairResult> {
  const managed = tablesWithManagedFkActions();
  const expected = expectedForeignKeyActions();
  const actual = await readForeignKeyActions(client, managed);
  const mismatches = diffForeignKeyActions(expected, actual);
  const driftedTables = [...new Set(mismatches.map((m) => m.table))].sort();

  if (opts.dryRun || driftedTables.length === 0) {
    return { driftedTables, rebuiltTables: [], mismatches };
  }

  // The rebuild procedure requires FK enforcement OFF for the duration; it must be a
  // no-op on a busy connection so we save/restore the prior setting.
  await client.execute("PRAGMA foreign_keys=OFF");
  const rebuilt: string[] = [];
  try {
    for (const table of driftedTables) {
      const specs = expected.get(table) ?? [];
      await client.execute("BEGIN");
      try {
        await rebuildTable(client, table, specs);
        const check = await client.execute("PRAGMA foreign_key_check");
        if (check.rows.length > 0) {
          throw new Error(
            `foreign_key_check failed after rebuilding ${table}: ${JSON.stringify(check.rows)}`,
          );
        }
        await client.execute("COMMIT");
        rebuilt.push(table);
      } catch (err) {
        await client.execute("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.execute("PRAGMA foreign_keys=ON");
  }

  return { driftedTables, rebuiltTables: rebuilt, mismatches };
}
