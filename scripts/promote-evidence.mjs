/**
 * Accumulated-gate evidence for a promotion (#1045) — the PURE half.
 *
 * Every pre-merge gate already writes one row into the test-impact ledger
 * (`packages/server/src/services/test-impact-outcome.service.ts` → `recordVerifyGateOutcome` →
 * `impact.mjs record`, landing in `.test-impact/outcomes.jsonl` in the MAIN checkout). Ten green
 * gates covering a hundred changed files were therefore already recorded — and read by nothing.
 * A promotion looked only at `base_branch_health`, so those runs gave it exactly zero evidence,
 * and when a sweep was structurally unreachable it took `--force-sweep` (the companion ticket
 * #1044).
 *
 * This module summarizes those rows so `pnpm promote` can PRINT them. It deliberately returns no
 * boolean and authorizes nothing:
 *
 *   A gate run is a SELECTION over ONE branch's diff, scored against a possibly-stale impact map,
 *   run against that branch and not against master's merge result. A sweep is the full suite over
 *   the base branch itself. They are not the same verdict and one is not N of the other.
 *
 * So the summary carries the counts a human can weigh (how many gates, how many files, how much
 * of it is suspect) and the label saying what it is NOT. Anything that turned this into a
 * promote-authorizing threshold would recreate `--force-sweep` with a friendlier name.
 *
 * Row shape (written by the skill's single writer, `writeOutcome` in `impact.mjs`):
 *   { at, commit, source, result: "pass"|"fail", changed: [], selected: [], failed: [], missed: [],
 *     tier, ran, ... }
 *
 * `source` is the producer's vocabulary: `ci` for a pre-merge gate, `base-sweep` for the periodic
 * base-branch probe, plus quality suffixes (`-nochange`, `-partialselection`, `-unattributed`)
 * that mark a row the skill's own miss-rate report excludes. This module honours those suffixes
 * for exactly the same reason: a row that measured nothing must not be counted as evidence.
 */
import { join } from "node:path";

/** Where the ledger lives, relative to the checkout that owns it. */
export const OUTCOMES_RELPATH = join(".test-impact", "outcomes.jsonl");

/** The `source` prefix a pre-merge gate row carries (`recordVerifyGateOutcome` passes `"ci"`). */
export const GATE_SOURCE = "ci";

/** The `source` a base-branch sweep row carries (`recordBaseSweepOutcome`). */
export const SWEEP_SOURCE = "base-sweep";

/** One JSON object per line; an unparseable line is dropped, exactly as the skill's reader does. */
export function parseOutcomeRows(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      /* a half-written last line is normal for an append-only log */
    }
  }
  return rows;
}

function sourceOf(row) {
  return String(row?.source ?? "");
}

/** A pre-merge gate row, suffixes included. */
export function isGateRow(row) {
  const s = sourceOf(row);
  return s === GATE_SOURCE || s.startsWith(`${GATE_SOURCE}-`);
}

/** A row the producer itself tagged as not an observation (`-nochange`, `-partialselection`, …). */
export function isSuspectRow(row) {
  const s = sourceOf(row);
  return s.startsWith(`${GATE_SOURCE}-`) || s.startsWith(`${SWEEP_SOURCE}-`);
}

function timeOf(row) {
  const at = row?.at ?? null;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What the gate runs since `sinceIso` add up to.
 *
 * `sinceIso` is normally the timestamp of the last sweep verdict, which is what makes the number
 * answer the question a promotion actually has ("what has been checked since the last thing that
 * checked everything?"). Rows with no readable timestamp are counted as `undated` rather than
 * silently assumed to be in or out of the window.
 */
export function summarizeGateEvidence(rows, { sinceIso = null, ledgerPath = null } = {}) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const since = Number.isFinite(sinceMs) ? sinceMs : null;

  const summary = {
    ledgerPath,
    since: since === null ? null : sinceIso,
    totalRows: rows.length,
    green: 0,
    red: 0,
    suspect: 0,
    undated: 0,
    sweepRows: 0,
    files: [],
    fileCount: 0,
    firstAt: null,
    lastAt: null,
  };

  const files = new Set();
  for (const row of rows) {
    const ms = timeOf(row);
    if (ms === null) {
      if (isGateRow(row)) summary.undated += 1;
      continue;
    }
    if (since !== null && ms <= since) continue;
    if (sourceOf(row) === SWEEP_SOURCE || sourceOf(row).startsWith(`${SWEEP_SOURCE}-`)) {
      summary.sweepRows += 1;
      continue;
    }
    if (!isGateRow(row)) continue;

    if (summary.firstAt === null || ms < Date.parse(summary.firstAt)) summary.firstAt = row.at;
    if (summary.lastAt === null || ms > Date.parse(summary.lastAt)) summary.lastAt = row.at;

    if (isSuspectRow(row)) {
      summary.suspect += 1;
      continue;
    }
    if (row.result === "pass") {
      summary.green += 1;
      for (const f of Array.isArray(row.changed) ? row.changed : []) files.add(String(f));
    } else if (row.result === "fail") {
      summary.red += 1;
    }
  }

  summary.files = [...files].sort();
  summary.fileCount = summary.files.length;
  return summary;
}

/**
 * One line for the promote output. Always names what this evidence is NOT — a bare
 * "7 green gate runs" beside a sweep verdict would read as a weaker sweep rather than as a
 * different measurement, which is the misreading that leads straight back to `--force-sweep`.
 */
export function formatGateEvidence(summary) {
  if (!summary) return "not read";
  if (summary.unreadable) return `no ledger at ${summary.ledgerPath ?? "<unknown>"} (${summary.unreadable})`;
  const window = summary.since ? `since the last sweep (${summary.since})` : "over the whole ledger (no sweep timestamp to measure from)";
  if (summary.green === 0 && summary.red === 0 && summary.suspect === 0) {
    return `no gate runs recorded ${window}`;
  }
  const caveats = [];
  if (summary.red > 0) caveats.push(`${summary.red} red`);
  if (summary.suspect > 0) caveats.push(`${summary.suspect} suspect (excluded)`);
  if (summary.undated > 0) caveats.push(`${summary.undated} undated (excluded)`);
  if (summary.sweepRows > 0) caveats.push(`${summary.sweepRows} sweep row(s) in the same window`);
  return (
    `${summary.green} green gate run(s) covering ${summary.fileCount} changed file(s) ${window}` +
    `${caveats.length > 0 ? ` [${caveats.join(", ")}]` : ""} — ` +
    `WEAKER THAN A SWEEP: each was a ranked SELECTION over one branch's diff, not the full suite over the base. Authorizes nothing.`
  );
}
