/**
 * Foreign-key action parity between the Drizzle schema and a live/migrated DB
 * (arch-review #881).
 *
 * The schema↔migrations drift gate (#871) compares the TABLE + COLUMN sets but
 * deliberately skipped FK actions/defaults. That left a real hole: a service can
 * believe a delete cascades (because the Drizzle schema says `onDelete: "cascade"`)
 * while the live DB enforces RESTRICT/NO ACTION — the exact drift #858 hit, where
 * `issue_dependencies` cascade clauses lived in the schema but an older live DB had
 * been created without them. The final issue-row delete then FK-fails.
 *
 * This module is the single source of truth for "what FK actions does the schema
 * expect" and "what does the live DB actually have", plus the diff between them. It
 * is pure and node-safe: it imports only the Drizzle schema (compile-time table
 * configs) and takes the libsql client as a parameter, so it never pulls a Node
 * builtin into the client bundle. Consumed by:
 *   - the drift test (fresh-migrated DB must match the schema), and
 *   - the db:repair FK-alignment path (align an old live DB to the schema).
 */
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "../schema/index.js";

/** SQLite FK action, normalised to the lowercase spelling SQLite stores. */
export type FkAction = "no action" | "restrict" | "set null" | "set default" | "cascade";

/** One foreign key, keyed by (its local columns → target table). */
export interface ForeignKeySpec {
  /** Local column DB-names that make up this FK, in order. */
  columns: string[];
  /** Referenced table DB-name. */
  refTable: string;
  /** Referenced column DB-names, in order. */
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
}

export interface ForeignKeyMismatch {
  table: string;
  /** `col1,col2 -> refTable` — stable identity of the FK within the table. */
  fk: string;
  field: "onDelete" | "onUpdate";
  expected: FkAction;
  actual: FkAction;
}

/**
 * Normalise any FK-action spelling (Drizzle's `undefined`/`"set null"`, SQLite's
 * `"NO ACTION"`/`"SET NULL"`) to the canonical lowercase form. Drizzle omits the
 * action entirely when it is the SQLite default (`NO ACTION`).
 */
export function normalizeFkAction(action: string | null | undefined): FkAction {
  const normalized = (action ?? "no action").trim().toLowerCase();
  switch (normalized) {
    case "":
    case "no action":
      return "no action";
    case "restrict":
      return "restrict";
    case "set null":
      return "set null";
    case "set default":
      return "set default";
    case "cascade":
      return "cascade";
    default:
      // Unknown spelling — surface it rather than silently coercing.
      return normalized as FkAction;
  }
}

/** Stable per-table identity for an FK so expected/actual can be matched. */
export function fkKey(spec: Pick<ForeignKeySpec, "columns" | "refTable">): string {
  return `${spec.columns.join(",")} -> ${spec.refTable}`;
}

/**
 * The FK actions the Drizzle schema expects, keyed by table DB-name. This is the
 * authoritative "what cascades should exist" set.
 */
export function expectedForeignKeyActions(): Map<string, ForeignKeySpec[]> {
  const result = new Map<string, ForeignKeySpec[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const specs: ForeignKeySpec[] = [];
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      specs.push({
        columns: ref.columns.map((c) => c.name),
        refTable: ref.foreignTable ? getTableConfig(ref.foreignTable).name : "",
        refColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: normalizeFkAction(fk.onDelete),
        onUpdate: normalizeFkAction(fk.onUpdate),
      });
    }
    result.set(config.name, specs);
  }
  return result;
}

/** Minimal shape of the libsql client this module needs (avoids a value import). */
export interface FkPragmaClient {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

interface ForeignKeyListRow {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  seq: number;
  id: number;
}

/**
 * The FK actions a live DB actually enforces, keyed by table name, read from
 * `PRAGMA foreign_key_list`. Multi-column FKs span several rows sharing one `id`
 * (ordered by `seq`); they are folded back into a single {@link ForeignKeySpec}.
 */
export async function readForeignKeyActions(
  client: FkPragmaClient,
  tableNames: string[],
): Promise<Map<string, ForeignKeySpec[]>> {
  const result = new Map<string, ForeignKeySpec[]>();
  for (const table of tableNames) {
    const res = await client.execute(`PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`);
    const rows = res.rows as unknown as ForeignKeyListRow[];
    // Group rows by FK id, preserving column order via seq.
    const byId = new Map<number, ForeignKeyListRow[]>();
    for (const row of rows) {
      const list = byId.get(row.id) ?? [];
      list.push(row);
      byId.set(row.id, list);
    }
    const specs: ForeignKeySpec[] = [];
    for (const group of byId.values()) {
      group.sort((a, b) => a.seq - b.seq);
      const head = group[0];
      specs.push({
        columns: group.map((g) => g.from),
        refTable: head.table,
        refColumns: group.map((g) => g.to),
        onDelete: normalizeFkAction(head.on_delete),
        onUpdate: normalizeFkAction(head.on_update),
      });
    }
    result.set(table, specs);
  }
  return result;
}

/**
 * Diff expected (schema) vs actual (live DB) FK actions. Only compares FKs that
 * exist on BOTH sides keyed by (columns → refTable): an FK present in the schema
 * but absent from the DB (or vice-versa) is a TABLE/COLUMN-level drift already
 * caught by the structural gate, not an action mismatch, so it is not reported
 * here. Returns one entry per (table, fk, field) that disagrees.
 */
export function diffForeignKeyActions(
  expected: Map<string, ForeignKeySpec[]>,
  actual: Map<string, ForeignKeySpec[]>,
): ForeignKeyMismatch[] {
  const mismatches: ForeignKeyMismatch[] = [];
  for (const [table, expectedSpecs] of expected) {
    const actualSpecs = actual.get(table);
    if (!actualSpecs) continue; // missing table — structural gate's job
    const actualByKey = new Map(actualSpecs.map((s) => [fkKey(s), s]));
    for (const exp of expectedSpecs) {
      const act = actualByKey.get(fkKey(exp));
      if (!act) continue; // missing FK — structural gate's job
      if (exp.onDelete !== act.onDelete) {
        mismatches.push({ table, fk: fkKey(exp), field: "onDelete", expected: exp.onDelete, actual: act.onDelete });
      }
      if (exp.onUpdate !== act.onUpdate) {
        mismatches.push({ table, fk: fkKey(exp), field: "onUpdate", expected: exp.onUpdate, actual: act.onUpdate });
      }
    }
  }
  return mismatches;
}

/** Tables that declare at least one non-default FK action in the schema. */
export function tablesWithManagedFkActions(): string[] {
  const tables: string[] = [];
  for (const [table, specs] of expectedForeignKeyActions()) {
    if (specs.some((s) => s.onDelete !== "no action" || s.onUpdate !== "no action")) {
      tables.push(table);
    }
  }
  return tables.sort();
}
