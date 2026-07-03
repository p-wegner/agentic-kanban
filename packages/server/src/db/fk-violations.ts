/**
 * Foreign-key VIOLATION sweep (#987).
 *
 * FK enforcement in SQLite/libsql is per-connection and only guards NEW writes —
 * `PRAGMA foreign_keys=ON` never validates rows that already exist. Ad-hoc scripts
 * that created bare clients (no pragmas) were able to insert rows whose FK target
 * does not exist (e.g. issues with `project_id='3276'`), and nothing ever noticed:
 * the startup FK guard (`startup/fk-alignment.ts`) asserts the PRAGMA and aligns
 * FK *actions*, but never ran `PRAGMA foreign_key_check` against existing data.
 *
 * This module provides that sweep:
 *  - `checkForeignKeyViolations` — run `PRAGMA foreign_key_check`, enrich each hit
 *    with a row snippet. Used at startup to log violations LOUDLY (never deletes).
 *  - `quarantineAndDeleteFkViolations` — the `pnpm db:repair` step: dump the full
 *    violating rows to a JSON quarantine file NEXT TO the DB first, then delete
 *    them inside a single transaction, and re-check. Touches nothing else.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Minimal client surface the sweep needs (libsql Client is structurally compatible). */
export interface FkSweepClient {
  execute(
    stmt: string | { sql: string; args: (string | number)[] },
  ): Promise<{ rows: Record<string, unknown>[]; rowsAffected?: number }>;
}

export interface FkViolation {
  /** Table containing the violating row. */
  table: string;
  /** rowid of the violating row (null for WITHOUT ROWID tables — none in our schema). */
  rowid: number | null;
  /** The referenced (missing-target) table. */
  parent: string;
  /** Index of the violated FK constraint within the table (PRAGMA foreign_key_list order). */
  fkid: number;
  /** JSON snippet of the violating row (truncated), for loud logging. */
  snippet: string;
}

export interface FkQuarantineResult {
  /** Violations found before any deletion. */
  violations: FkViolation[];
  /** Path of the JSON quarantine dump, or null when there was nothing to quarantine. */
  quarantinePath: string | null;
  /** Rows actually deleted (direct deletes; FK cascades may remove dependents too). */
  deletedRows: number;
  /** Violations still reported by a re-check after deletion (should be 0). */
  remaining: number;
}

const SNIPPET_MAX = 300;

/** Quote an identifier that came out of PRAGMA output. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

/** Decode a CAST(... AS BLOB) value leniently (invalid UTF-8 → U+FFFD, never throws). */
function decodeValue(v: unknown): unknown {
  if (v == null) return null;
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString("utf8");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (typeof v === "bigint") return Number(v);
  return v;
}

/**
 * Fetch a row with every column CAST to BLOB and decoded in JS. NOT `SELECT *`:
 * the exact rows this sweep exists to find can contain invalid UTF-8 (the live
 * violations do), and libsql's native binding PANICS (aborting the whole process)
 * when it decodes such a value as text. Blobs bypass the native decode; Node's
 * lenient UTF-8 decoding replaces bad bytes instead of crashing. Values therefore
 * come back stringified — fine for logging and the quarantine dump.
 */
async function fetchRow(
  client: FkSweepClient,
  table: string,
  rowid: number,
): Promise<Record<string, unknown> | null> {
  try {
    const info = await client.execute(`PRAGMA table_info(${quoteIdent(table)})`);
    const names = info.rows.map((r) => String(r.name));
    if (names.length === 0) return null;
    const select = names
      .map((n) => `CAST(${quoteIdent(n)} AS BLOB) AS ${quoteIdent(n)}`)
      .join(", ");
    const res = await client.execute({
      sql: `SELECT ${select} FROM ${quoteIdent(table)} WHERE rowid = ?`,
      args: [rowid],
    });
    const raw = res.rows[0];
    if (!raw) return null;
    const out: Record<string, unknown> = {};
    for (const n of names) out[n] = decodeValue(raw[n]);
    return out;
  } catch {
    return null;
  }
}

/**
 * Run `PRAGMA foreign_key_check` and return every violating row, enriched with a
 * truncated JSON snippet of the row itself so logs identify WHAT is orphaned, not
 * just a rowid. Read-only; never modifies data.
 */
export async function checkForeignKeyViolations(client: FkSweepClient): Promise<FkViolation[]> {
  const res = await client.execute("PRAGMA foreign_key_check");
  const violations: FkViolation[] = [];
  for (const raw of res.rows) {
    const table = String(raw.table);
    const rowid = raw.rowid == null ? null : Number(raw.rowid);
    const parent = String(raw.parent);
    const fkid = Number(raw.fkid ?? -1);
    let snippet = "(rowid unavailable)";
    if (rowid !== null) {
      const row = await fetchRow(client, table, rowid);
      snippet = row === null ? "(row fetch failed)" : JSON.stringify(row, bigintSafe);
      if (snippet.length > SNIPPET_MAX) snippet = snippet.slice(0, SNIPPET_MAX) + "…";
    }
    violations.push({ table, rowid, parent, fkid, snippet });
  }
  return violations;
}

/**
 * Log FK violations LOUDLY. Startup calls this and stops there — existing data is
 * never auto-deleted on boot; `pnpm db:repair` is the sanctioned removal path.
 */
export function logForeignKeyViolations(violations: FkViolation[], context = "startup"): void {
  console.error(
    `[${context}] PRAGMA foreign_key_check: ${violations.length} FK-violating row(s) in the live DB ` +
      `(orphaned rows whose referenced parent no longer exists). NOT auto-deleting — ` +
      `run \`pnpm db:repair\` to quarantine + remove them.`,
  );
  for (const v of violations) {
    console.error(
      `[${context}]   ${v.table} rowid=${v.rowid ?? "?"} → missing ${v.parent} (fk #${v.fkid}) row=${v.snippet}`,
    );
  }
}

/**
 * The `db:repair` FK-violations step: report violations; for rows whose FK target is
 * missing (everything `foreign_key_check` returns), dump the FULL rows to
 * `kanban-fk-quarantine-<timestamp>.json` in `quarantineDir` (next to the DB), then
 * delete them by rowid inside a single transaction. The quarantine file is written —
 * and must succeed — BEFORE any delete. A clean DB is a no-op (no file, no deletes).
 */
export async function quarantineAndDeleteFkViolations(
  client: FkSweepClient,
  quarantineDir: string,
): Promise<FkQuarantineResult> {
  const violations = await checkForeignKeyViolations(client);
  if (violations.length === 0) {
    return { violations, quarantinePath: null, deletedRows: 0, remaining: 0 };
  }

  // Group violating rowids per table (a row can violate several FKs — delete once).
  const byTable = new Map<string, Set<number>>();
  for (const v of violations) {
    if (v.rowid === null) continue; // can't target safely; stays reported, not deleted
    let set = byTable.get(v.table);
    if (!set) byTable.set(v.table, (set = new Set()));
    set.add(v.rowid);
  }

  // Dump the FULL rows (untruncated) before touching anything.
  const dump: { table: string; rowid: number; row: Record<string, unknown> | null }[] = [];
  for (const [table, rowids] of byTable) {
    for (const rowid of rowids) {
      dump.push({ table, rowid, row: await fetchRow(client, table, rowid) });
    }
  }
  mkdirSync(quarantineDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(quarantineDir, `kanban-fk-quarantine-${stamp}.json`);
  writeFileSync(
    quarantinePath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        reason: "PRAGMA foreign_key_check violations removed by pnpm db:repair (#987)",
        violations: violations.map(({ snippet: _s, ...rest }) => rest),
        rows: dump,
      },
      bigintSafe,
      2,
    ),
  );

  // Delete inside ONE transaction; roll back everything on any failure.
  let deletedRows = 0;
  await client.execute("BEGIN IMMEDIATE");
  try {
    for (const [table, rowids] of byTable) {
      const list = [...rowids];
      const placeholders = list.map(() => "?").join(", ");
      const res = await client.execute({
        sql: `DELETE FROM ${quoteIdent(table)} WHERE rowid IN (${placeholders})`,
        args: list,
      });
      deletedRows += Number(res.rowsAffected ?? list.length);
    }
    await client.execute("COMMIT");
  } catch (err) {
    try {
      await client.execute("ROLLBACK");
    } catch {
      /* connection-level failure — nothing more to do */
    }
    throw err;
  }

  const remaining = (await checkForeignKeyViolations(client)).length;
  return { violations, quarantinePath, deletedRows, remaining };
}
