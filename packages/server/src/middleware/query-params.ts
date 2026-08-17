/**
 * Query-parameter coercion (#511).
 *
 * Integer parsing was hand-rolled at 17 sites with genuinely different semantics, and two
 * of the variants were buggy rather than merely different:
 *
 *   - `parseInt(c.req.query("days") ?? "30", 10)` (milestones) passes **NaN** straight into
 *     the service when the caller sends `?days=abc`.
 *   - `Math.min(parseInt(q ?? "3", 10) || 3, 10)` (failure-patterns) **swallows an explicit
 *     0** — `0 || 3` is 3 — and has no lower clamp, so `?limit=-5` reaches the query as -5.
 *
 * Boolean flags were split between `=== "true"` (8 sites) and `=== "1"` (7 sites), so a
 * client sending the other spelling was silently ignored with no error — the worst kind of
 * wire-format bug, because the request succeeds and the flag just does nothing.
 *
 * `queryFlag` therefore accepts BOTH spellings (plus `yes`/`on`). That is a widening: a
 * `?force=1` that used to be ignored by a `=== "true"` route now takes effect. That is the
 * intended fix — those callers were asking for the flag and being ignored — but it is a
 * behaviour change, not a pure refactor, which is why it is stated here.
 */
import type { Context } from "hono";

export interface QueryIntOptions {
  /** Returned when the parameter is absent, empty, or unparseable. */
  def: number;
  /** Inclusive lower bound, applied after parsing. */
  min?: number;
  /** Inclusive upper bound, applied after parsing. */
  max?: number;
}

/**
 * Parse an integer query parameter, falling back to `def` and clamping to `[min, max]`.
 *
 * Unparseable input yields `def` rather than NaN. An explicit `0` is preserved (it is only
 * replaced if it falls outside an explicit `min`), which is the zero-swallow bug above.
 */
export function queryInt(c: Context, name: string, opts: QueryIntOptions): number {
  const raw = c.req.query(name);
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number.parseInt(raw, 10);
  let value = Number.isFinite(parsed) ? parsed : opts.def;
  if (opts.min !== undefined && value < opts.min) value = opts.min;
  if (opts.max !== undefined && value > opts.max) value = opts.max;
  return value;
}

/** Truthy spellings accepted on the wire. Lowercased before comparison. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Read a boolean flag query parameter.
 *
 * Absent, empty, or any non-truthy spelling is `false` — a bare `?flag` (empty value) stays
 * false, matching every previous `=== "true"` / `=== "1"` site.
 */
export function queryFlag(c: Context, name: string): boolean {
  const raw = c.req.query(name);
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
