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

// --- the impact-tier miss rate (#1234) --------------------------------------------------------
//
// MIRROR of `packages/server/src/services/test-impact-miss-rate.ts` — a published `packages/server`
// cannot import a repo-root script and `pnpm promote` runs without the server, so the pure rate
// lives twice and `test-impact-miss-rate.test.ts` holds both copies to one behaviour on one
// fixture. Change both or the lockstep test goes red.
//
//   missRate = misses / merges, per selection tier, since the corpus start.
//
// `merges` are the non-suspect gate rows of a tier (one per gate run); `misses` are the sidecar's
// `miss` rows (`.test-impact/misses.jsonl`, written by the sweep join) of that tier whose
// candidates were all valid observations; a miss with a stale-map candidate is counted in
// `staleExcluded` instead. Like the gate evidence above it is PRINTED and authorizes nothing.

/** Where the sweep join's sidecar lives, relative to the checkout that owns the outcomes ledger. */
export const MISSES_RELPATH = join(".test-impact", "misses.jsonl");

const UNKNOWN_TIER = "unknown";
const SUSPECT_SUFFIXES = ["-nochange", "-partialselection", "-unattributed"];

function isSuspectGateRow(row) {
  const s = sourceOf(row);
  return SUSPECT_SUFFIXES.some((suffix) => s.includes(suffix));
}

function rowTimeMs(row) {
  const at = row?.at ?? row?.sweepAt ?? null;
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Pure: the per-tier miss rate over the parsed outcomes ledger and the parsed misses sidecar. */
export function summarizeMissRate(ledgerRows, missRows) {
  const byTier = new Map();
  const tierFor = (tier) => {
    const key = typeof tier === "string" && tier.length > 0 ? tier : UNKNOWN_TIER;
    let entry = byTier.get(key);
    if (!entry) {
      entry = { tier: key, misses: 0, merges: 0, rate: null, staleExcluded: 0 };
      byTier.set(key, entry);
    }
    return entry;
  };
  let sinceMs = null;
  let since = null;
  for (const row of ledgerRows ?? []) {
    if (!isGateRow(row) || isSuspectGateRow(row)) continue;
    tierFor(row.tier).merges += 1;
    const ms = rowTimeMs(row);
    if (ms !== null && (sinceMs === null || ms < sinceMs)) {
      sinceMs = ms;
      since = String(row.at);
    }
  }
  let lastSweepAt = null;
  let lastSweepMs = null;
  for (const row of missRows ?? []) {
    const ms = rowTimeMs(row);
    if (ms !== null && (lastSweepMs === null || ms > lastSweepMs)) {
      lastSweepMs = ms;
      lastSweepAt = row.sweepAt;
    }
    if (row?.kind !== "miss") continue;
    const entry = tierFor(row.tier);
    if (row.staleMap) entry.staleExcluded += 1;
    else entry.misses += 1;
  }
  for (const entry of byTier.values()) {
    entry.rate = entry.merges > 0 ? entry.misses / entry.merges : null;
  }
  const tiers = [...byTier.values()].sort((a, b) => b.merges - a.merges || a.tier.localeCompare(b.tier));
  return { since, lastSweepAt, tiers };
}

/** One line for the promote output — mirrors `formatMissRate` in the server module, caveat included. */
export function formatMissRate(summary) {
  if (!summary) return "not read (no ledger)";
  if (summary.unreadable) return `no ledger at ${summary.ledgerPath ?? "<unknown>"} (${summary.unreadable})`;
  if (summary.tiers.length === 0) return "no gate rows recorded yet — the corpus is empty";
  const parts = summary.tiers.map((t) => {
    const pct = t.rate === null ? "n/a" : `${(t.rate * 100).toFixed(1)}%`;
    const stale = t.staleExcluded > 0 ? `, ${t.staleExcluded} stale-map miss(es) excluded` : "";
    return `${t.tier}: ${t.misses}/${t.merges} = ${pct}${stale}`;
  });
  const window = summary.since ? `since ${summary.since}` : "undated";
  const sweep = summary.lastSweepAt ? `, last sweep joined ${summary.lastSweepAt}` : ", no sweep joined yet";
  return `${parts.join("; ")} (${window}${sweep}) — misses / gate runs per tier; a corpus measurement, not a verdict on any merge. Authorizes nothing.`;
}
