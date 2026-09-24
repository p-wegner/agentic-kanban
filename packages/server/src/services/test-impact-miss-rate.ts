/**
 * The impact-tier miss RATE (#1234, #954 step 5) — a pure function over the two ledgers.
 *
 *   missRate = misses / merges, per selection tier, since the corpus start.
 *
 * `merges` are the outcome-ledger gate rows (`source: ci*`) of that tier that the gate itself
 * did NOT tag as a non-observation — one row per gate run, which is one per merge attempt, so a
 * branch re-gated after a fix counts twice; the number is reported as what it counts. `misses`
 * are the sidecar's `miss` rows of that tier (`test-impact-misses.ts` — a sweep red that no
 * intervening gate ran). A miss whose candidates include a stale-map row is EXCLUDED from the
 * numerator and counted in `staleExcluded`, so a stale map inflates a visible counter rather
 * than the rate. `since` is the earliest gate row's timestamp: the corpus start.
 *
 * MIRRORED in `scripts/promote-evidence.mjs` (`summarizeMissRate` / `formatMissRate`) because a
 * published `packages/server` cannot import a repo-root script and `pnpm promote` runs without
 * the server. `test-impact-miss-rate.test.ts` holds the two to the same behaviour on one fixture.
 *
 * It returns COUNTS and a ratio, never a verdict. The number is what decides whether a rung
 * of the risk ladder may become a default (`docs/integration-risk-ladder.md`); the deciding is a
 * person's, and `pnpm promote` labels the line exactly as it labels the gate evidence beside it:
 * it authorizes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ImpactMissRateSummary, ImpactMissRateTier } from "@agentic-kanban/shared/types";
import { OUTCOMES_RELATIVE_PATH } from "./test-impact-outcome.service.js";
import {
  MISSES_RELATIVE_PATH,
  isGateRow,
  isSuspectGateRow,
  parseJsonlRows,
  type LedgerRow,
  type SweepJoinRow,
} from "./test-impact-misses.js";

export type { ImpactMissRateSummary, ImpactMissRateTier };

/** A row with no readable tier is counted under this label rather than dropped. */
export const UNKNOWN_TIER = "unknown";

function timeOf(row: { at?: unknown; sweepAt?: unknown }): number | null {
  const at = row.at ?? row.sweepAt ?? null;
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Pure: the per-tier rate over the two parsed files. */
export function summarizeMissRate(ledgerRows: readonly LedgerRow[], missRows: readonly SweepJoinRow[]): ImpactMissRateSummary {
  const byTier = new Map<string, ImpactMissRateTier>();
  const tierFor = (tier: unknown): ImpactMissRateTier => {
    const key = typeof tier === "string" && tier.length > 0 ? tier : UNKNOWN_TIER;
    let entry = byTier.get(key);
    if (!entry) {
      entry = { tier: key, misses: 0, merges: 0, rate: null, staleExcluded: 0 };
      byTier.set(key, entry);
    }
    return entry;
  };
  let sinceMs: number | null = null;
  let since: string | null = null;
  for (const row of ledgerRows) {
    if (!isGateRow(row) || isSuspectGateRow(row)) continue;
    tierFor(row.tier).merges += 1;
    const ms = timeOf(row);
    if (ms !== null && (sinceMs === null || ms < sinceMs)) {
      sinceMs = ms;
      since = String(row.at);
    }
  }
  let lastSweepAt: string | null = null;
  let lastSweepMs: number | null = null;
  for (const row of missRows) {
    const ms = timeOf(row);
    if (ms !== null && (lastSweepMs === null || ms > lastSweepMs)) {
      lastSweepMs = ms;
      lastSweepAt = row.sweepAt;
    }
    if (row.kind !== "miss") continue;
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

/**
 * One line, the same shape `pnpm promote` prints beside the gate evidence. Always says what the
 * number is NOT: a rate over a corpus of ranked selections is not a verdict about any one merge.
 */
export function formatMissRate(summary: ImpactMissRateSummary | null | undefined): string {
  if (!summary) return "not read (no ledger)";
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

/**
 * Read both files under a project's main checkout and summarize. `null` when the outcomes ledger
 * does not exist (a project without the skill); an absent sidecar is an empty one. Never throws.
 */
export function readImpactMissRate(repoPath: string | null | undefined): ImpactMissRateSummary | null {
  if (!repoPath) return null;
  try {
    const outcomesPath = resolve(repoPath, OUTCOMES_RELATIVE_PATH);
    if (!existsSync(outcomesPath)) return null;
    const missesPath = resolve(repoPath, MISSES_RELATIVE_PATH);
    const ledgerRows = parseJsonlRows<LedgerRow>(readFileSync(outcomesPath, "utf8"));
    const missRows = existsSync(missesPath) ? parseJsonlRows<SweepJoinRow>(readFileSync(missesPath, "utf8")) : [];
    return summarizeMissRate(ledgerRows, missRows);
  } catch {
    return null;
  }
}
