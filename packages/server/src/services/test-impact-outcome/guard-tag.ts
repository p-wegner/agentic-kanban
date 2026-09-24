/**
 * Tag the ledger row a guard failure just produced with `guardFailure: true` (#1230).
 *
 * `impact.mjs record` owns the row's shape and takes no free-form field, so the tag cannot ride
 * on the argv the way `--source` does. The row is patched IN PLACE right after `record` appended
 * it: read the ledger, take the last line, confirm it is the row that was just written (same
 * verdict, same failed set — the gate's verify chain is serialized, so a stranger's row cannot
 * land in between, but the check makes that an assertion rather than an assumption), and rewrite
 * that one line with the tag. Anything unexpected — no file, a last line that does not parse, a
 * row that does not match — leaves the ledger untouched and reports why.
 *
 * Why a tag at all, when `--source` already carries a `-guardfailure` suffix: `stats`' miss-rate
 * join reads `failed` against `selected`; a guard is always selected (`--always-run`), so it can
 * never be a MISS, but a corpus consumer grouping failures by cause has nothing else to key on.
 * The tag is the structured form; the source suffix is what today's `bySource` breakdown sees.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface TagGuardFailureRowResult {
  tagged: boolean;
  reason?: string;
}

/** Pure half: patch the LAST row of a JSONL document when it matches; unchanged text otherwise. */
export function tagLastLedgerRow(
  text: string,
  expect: { result: "pass" | "fail"; failed: readonly string[] },
  tag: Record<string, unknown>,
): { text: string; tagged: boolean; reason?: string } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const cut = body.lastIndexOf("\n");
  const head = cut === -1 ? "" : body.slice(0, cut + 1);
  const last = cut === -1 ? body : body.slice(cut + 1);
  if (!last.trim()) return { text, tagged: false, reason: "ledger has no last row" };
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(last) as Record<string, unknown>;
  } catch {
    return { text, tagged: false, reason: "last ledger row is not JSON" };
  }
  const failed = Array.isArray(row.failed) ? (row.failed as unknown[]).map(String).sort() : [];
  const expected = [...expect.failed].sort();
  if (row.result !== expect.result || failed.join("\n") !== expected.join("\n")) {
    return { text, tagged: false, reason: "last ledger row is not the row just recorded" };
  }
  const patched = JSON.stringify({ ...row, ...tag });
  return { text: `${head}${patched}${trailingNewline ? "\n" : ""}`, tagged: true };
}

/** I/O half: apply {@link tagLastLedgerRow} to the ledger file. Never throws. */
export function tagGuardFailureRow(
  outcomesPath: string,
  expect: { result: "pass" | "fail"; failed: readonly string[] },
  extra: Record<string, unknown> = {},
): TagGuardFailureRowResult {
  try {
    const text = readFileSync(outcomesPath, "utf8");
    const patched = tagLastLedgerRow(text, expect, { guardFailure: true, ...extra });
    if (!patched.tagged) return { tagged: false, reason: patched.reason };
    writeFileSync(outcomesPath, patched.text, "utf8");
    return { tagged: true };
  } catch (err) {
    return { tagged: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
