/**
 * Invalid-UTF-8 row repair (arch-review #960).
 *
 * libsql's Rust binding PANICS the whole process (`Utf8Error`, `value.rs:237`,
 * process-fatal — not a catchable JS error) when a plain `SELECT` decodes a TEXT
 * column containing bytes that are not valid UTF-8. Any query touching such a row
 * kills the backend, and callers that re-read the same rows (the monitor, board
 * polling) turn this into a crash loop.
 *
 * This module provides the tolerant scan + in-place repair `pnpm db:repair` runs:
 *  - `findInvalidUtf8Rows` — read every TEXT column of the given tables via
 *    `CAST(col AS BLOB)` (bypasses the native UTF-8 decode entirely) and decode
 *    leniently in JS (`Buffer#toString("utf8")` replaces bad bytes with U+FFFD
 *    instead of throwing), then compare byte-length round-trip to detect which
 *    columns actually contained invalid bytes.
 *  - `repairInvalidUtf8Rows` — UPDATE each affected column in place with the
 *    lenient-decoded (now valid) text, so no session_messages/sessions row keeps
 *    the byte sequence that panics the driver. Never deletes rows.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Minimal client surface this sweep needs (libsql Client is structurally compatible). */
export interface Utf8SweepClient {
  execute(
    stmt: string | { sql: string; args: (string | number)[] },
  ): Promise<{ rows: Record<string, unknown>[]; rowsAffected?: number }>;
}

export interface Utf8Violation {
  table: string;
  rowid: number;
  /** Column name → repaired (lenient-decoded, now valid) text. */
  columns: Record<string, string>;
}

export interface Utf8RepairResult {
  violations: Utf8Violation[];
  quarantinePath: string | null;
  repairedRows: number;
}

const SNIPPET_MAX = 300;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Does `raw` (bytes from `CAST(col AS BLOB)`) contain invalid UTF-8? Round-trips
 * through a lenient decode + re-encode: a valid UTF-8 buffer is byte-identical
 * after the round-trip, an invalid one is NOT (replacement chars change length),
 * because Node's `toString("utf8")` never throws — it substitutes U+FFFD.
 */
function hasInvalidUtf8(raw: Buffer): boolean {
  const decoded = raw.toString("utf8");
  return !Buffer.from(decoded, "utf8").equals(raw);
}

/** Only TEXT columns (BLOB/INTEGER/REAL columns cannot carry this hazard). */
async function textColumns(client: Utf8SweepClient, table: string): Promise<string[]> {
  const info = await client.execute(`PRAGMA table_info(${quoteIdent(table)})`);
  return info.rows
    .filter((r) => String(r.type).toUpperCase().includes("TEXT"))
    .map((r) => String(r.name));
}

/**
 * Scan `tables` for rows whose TEXT columns contain invalid UTF-8 bytes. Entirely
 * read-only — every column is read via `CAST(... AS BLOB)` so the native decode
 * (which panics on bad bytes) is never invoked.
 */
export async function findInvalidUtf8Rows(
  client: Utf8SweepClient,
  tables: string[],
): Promise<Utf8Violation[]> {
  const violations: Utf8Violation[] = [];
  for (const table of tables) {
    const columns = await textColumns(client, table);
    if (columns.length === 0) continue;
    const select = columns.map((c) => `CAST(${quoteIdent(c)} AS BLOB) AS ${quoteIdent(c)}`).join(", ");
    const res = await client.execute(`SELECT rowid AS __rowid, ${select} FROM ${quoteIdent(table)}`);
    for (const row of res.rows) {
      const rowid = Number(row.__rowid);
      const repaired: Record<string, string> = {};
      for (const col of columns) {
        const value = row[col];
        if (value == null) continue;
        const raw = value instanceof ArrayBuffer
          ? Buffer.from(value)
          : value instanceof Uint8Array
            ? Buffer.from(value)
            : null;
        if (raw === null) continue; // shouldn't happen for a BLOB-cast TEXT column
        if (hasInvalidUtf8(raw)) repaired[col] = raw.toString("utf8");
      }
      if (Object.keys(repaired).length > 0) violations.push({ table, rowid, columns: repaired });
    }
  }
  return violations;
}

function snippetOf(violation: Utf8Violation): string {
  const s = JSON.stringify(violation.columns, bigintSafe);
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "…" : s;
}

/** Log violations LOUDLY without modifying anything — used at startup. */
export function logInvalidUtf8Rows(violations: Utf8Violation[], context = "startup"): void {
  console.error(
    `[${context}] found ${violations.length} row(s) with invalid UTF-8 text — libsql panics ` +
      `(process-fatal) reading these directly. NOT auto-repairing here — run \`pnpm db:repair\`.`,
  );
  for (const v of violations) {
    console.error(`[${context}]   ${v.table} rowid=${v.rowid} columns=${snippetOf(v)}`);
  }
}

/**
 * The `db:repair` step: scan `tables`, dump the full violating rows (repaired
 * values, for audit) to a quarantine JSON next to the DB, then UPDATE each
 * affected column in place with the lenient-decoded (valid) text — repair, not
 * delete. A clean DB is a no-op (no file, no updates).
 */
export async function repairInvalidUtf8Rows(
  client: Utf8SweepClient,
  tables: string[],
  quarantineDir: string,
): Promise<Utf8RepairResult> {
  const violations = await findInvalidUtf8Rows(client, tables);
  if (violations.length === 0) {
    return { violations, quarantinePath: null, repairedRows: 0 };
  }

  mkdirSync(quarantineDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(quarantineDir, `kanban-utf8-repair-${stamp}.json`);
  writeFileSync(
    quarantinePath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        reason: "invalid-UTF-8 TEXT values repaired in place by pnpm db:repair (arch-review #960)",
        violations,
      },
      bigintSafe,
      2,
    ),
  );

  let repairedRows = 0;
  await client.execute("BEGIN IMMEDIATE");
  try {
    for (const v of violations) {
      const setClause = Object.keys(v.columns).map((c) => `${quoteIdent(c)} = ?`).join(", ");
      const args = [...Object.values(v.columns), v.rowid];
      await client.execute({
        sql: `UPDATE ${quoteIdent(v.table)} SET ${setClause} WHERE rowid = ?`,
        args,
      });
      repairedRows++;
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

  return { violations, quarantinePath, repairedRows };
}

/** Tables known to receive raw agent-derived text (arch-review #960). */
export const UTF8_REPAIR_TABLES = ["session_messages", "sessions"] as const;
