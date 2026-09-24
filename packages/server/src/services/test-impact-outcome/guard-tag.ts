/**
 * Patch the ledger row `impact.mjs record` just appended with the fields it cannot carry.
 *
 * `impact.mjs record` owns the row's shape and takes no free-form field, so a structured tag
 * cannot ride on the argv the way `--source` does. The row is patched IN PLACE right after
 * `record` appended it: read the ledger, take the last line, confirm it is the row that was just
 * written (same verdict, same failed set — the gate's verify chain is serialized, so a stranger's
 * row cannot land in between, but the check makes that an assertion rather than an assumption),
 * and rewrite that one line with the extra fields. Anything unexpected — no file, a last line that
 * does not parse, a row that does not match — leaves the ledger untouched and reports why.
 *
 * Three producers use it today:
 *
 * - **`retried: [...]` (#1242).** The suites a targeted flake re-run (#894) was attempted for,
 *   repo-relative like `failed`, on both verdicts — so a suite that keeps needing a retry is
 *   countable, and a red row that survived its retry is distinguishable from one never retried.
 * - **`guardFailure: true` (#1230).** `--source` already carries a `-guardfailure` suffix, but
 *   `stats`' miss-rate join reads `failed` against `selected`; a guard is always selected
 *   (`--always-run`), so it can never be a MISS, and a corpus consumer grouping failures by cause
 *   has nothing else to key on. The tag is the structured form; the source suffix is what
 *   today's `bySource` breakdown sees.
 * - **`durationMs` + `steps` (#1234).** The verify wall clock and the `[gate:step]` seconds per
 *   step (`arch`, `typecheck`, `tests`). `docs/two-boards.md` had claimed the ledger carried a
 *   runtime since #1045; until this landed the only measured gate costs were the merge-train
 *   timestamps and `base_branch_health.durationMs`. See {@link gateRowExtras}.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { VerifyStepTiming } from "../verify-step-timings.js";

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

/** I/O half: apply {@link tagLastLedgerRow} to the ledger file with arbitrary fields. Never throws. */
export function patchLastRow(
  outcomesPath: string,
  expect: { result: "pass" | "fail"; failed: readonly string[] },
  fields: Record<string, unknown>,
): TagGuardFailureRowResult {
  try {
    const text = readFileSync(outcomesPath, "utf8");
    const patched = tagLastLedgerRow(text, expect, fields);
    if (!patched.tagged) return { tagged: false, reason: patched.reason };
    writeFileSync(outcomesPath, patched.text, "utf8");
    return { tagged: true };
  } catch (err) {
    return { tagged: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The #1230 form of {@link patchLastRow}: `guardFailure: true` plus anything else the caller adds. */
export function tagGuardFailureRow(
  outcomesPath: string,
  expect: { result: "pass" | "fail"; failed: readonly string[] },
  extra: Record<string, unknown> = {},
): TagGuardFailureRowResult {
  return patchLastRow(outcomesPath, expect, { guardFailure: true, ...extra });
}

/** The step names a ledger row records seconds for; anything else the script reports is dropped. */
const LEDGER_STEP_NAMES = ["arch", "typecheck", "tests"] as const;

/**
 * The fields a gate run adds to its ledger row beyond what `impact.mjs record` writes (#1230,
 * #1234). Pure; `{}` when there is nothing to add, so the caller can skip the patch entirely.
 *
 * - `guardFailure: true` when every failing suite was a guard.
 * - `durationMs` — the verify WALL CLOCK (`tierInfo.verifyRunMs`, the first run only: an
 *   install or flake retry is a different measurement and would double the number).
 * - `steps` — `{arch, typecheck, tests}` seconds off the `[gate:step]` lines, only the steps
 *   the script actually reported. A row with a `durationMs` and no `steps` is a project whose
 *   verify script emits no step contract; both absent is a row from before this field existed.
 */
export function gateRowExtras(input: {
  guardFailure?: boolean;
  /** #1242 — repo-relative suites a targeted flake re-run was attempted for; omitted when none. */
  retried?: readonly string[];
  tierInfo: { verifyRunMs?: number; stepTimings?: VerifyStepTiming[] } | null | undefined;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (input.guardFailure) extras.guardFailure = true;
  if (input.retried && input.retried.length > 0) extras.retried = [...input.retried];
  const wallMs = input.tierInfo?.verifyRunMs;
  if (typeof wallMs === "number" && Number.isFinite(wallMs) && wallMs >= 0) extras.durationMs = Math.round(wallMs);
  const steps: Record<string, number> = {};
  for (const step of input.tierInfo?.stepTimings ?? []) {
    if ((LEDGER_STEP_NAMES as readonly string[]).includes(step.name) && Number.isFinite(step.seconds)) {
      steps[step.name] = step.seconds;
    }
  }
  if (Object.keys(steps).length > 0) extras.steps = steps;
  return extras;
}
