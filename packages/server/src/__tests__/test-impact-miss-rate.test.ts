// @covers review-merge.merge.gate-verify [measurement]
/**
 * #1234 — the impact-tier miss RATE: misses / merges per tier over the two ledgers, with a
 * stale-map miss excluded from the numerator and counted separately.
 *
 * The rate lives twice on purpose (server module + `scripts/promote-evidence.mjs`, see the header
 * of either). The LOCKSTEP check that holds the two copies to one behaviour lives in
 * `promote-evidence.test.ts`, which already carries the `@gate:always-run when:` marker for the
 * cross-package import — a second marked suite would grow the guard floor for nothing (#1042).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMissRate, readImpactMissRate, summarizeMissRate } from "../services/test-impact-miss-rate.js";
import { MISSES_RELATIVE_PATH, type LedgerRow, type SweepJoinRow } from "../services/test-impact-misses.js";
import { OUTCOMES_RELATIVE_PATH } from "../services/test-impact-outcome.service.js";

const gate = (over: Partial<LedgerRow>): LedgerRow => ({
  at: "2026-09-20T01:00:00.000Z", commit: "abc1234", source: "ci", result: "pass", changed: [], selected: [], failed: [], tier: "impact", ran: "impact-scoped", ...over,
});

const LEDGER: LedgerRow[] = [
  gate({ at: "2026-09-21T01:00:00.000Z" }),
  gate({ at: "2026-09-20T01:00:00.000Z" }),
  gate({ at: "2026-09-22T01:00:00.000Z" }),
  gate({ at: "2026-09-22T02:00:00.000Z", tier: "package" }),
  // Excluded from the denominator: the gate itself said the row measured nothing.
  gate({ at: "2026-09-19T01:00:00.000Z", source: "ci-nochange" }),
  // Not a gate row at all.
  gate({ at: "2026-09-18T01:00:00.000Z", source: "base-sweep" }),
];

const MISSES: SweepJoinRow[] = [
  { kind: "miss", sweepAt: "2026-09-23T04:00:00.000Z", sweepSha: "s1", suite: "a", candidateCommits: ["abc1234"], tier: "impact" },
  { kind: "miss", sweepAt: "2026-09-23T04:00:00.000Z", sweepSha: "s1", suite: "b", candidateCommits: ["abc1234"], tier: "impact", staleMap: true },
  { kind: "flake-or-environment", sweepAt: "2026-09-23T04:00:00.000Z", sweepSha: "s1", suite: "c" },
  { kind: "heal", sweepAt: "2026-09-24T04:00:00.000Z", sweepSha: "s2", suites: ["a", "b", "c"] },
];

describe("summarizeMissRate", () => {
  it("computes misses / merges per tier, excludes a stale-map miss and counts it, and dates the corpus", () => {
    const summary = summarizeMissRate(LEDGER, MISSES);
    expect(summary).toEqual({
      since: "2026-09-20T01:00:00.000Z",
      lastSweepAt: "2026-09-24T04:00:00.000Z",
      tiers: [
        { tier: "impact", misses: 1, merges: 3, rate: 1 / 3, staleExcluded: 1 },
        { tier: "package", misses: 0, merges: 1, rate: 0, staleExcluded: 0 },
      ],
    });
  });

  it("reports a tier with misses but no merges as rate null rather than dividing by zero", () => {
    const summary = summarizeMissRate([], MISSES);
    expect(summary.tiers).toEqual([{ tier: "impact", misses: 1, merges: 0, rate: null, staleExcluded: 1 }]);
    expect(summary.since).toBeNull();
  });

  it("formats one line that names the rate per tier and says it authorizes nothing", () => {
    const line = formatMissRate(summarizeMissRate(LEDGER, MISSES));
    expect(line).toContain("impact: 1/3 = 33.3%, 1 stale-map miss(es) excluded");
    expect(line).toContain("package: 0/1 = 0.0%");
    expect(line).toContain("since 2026-09-20T01:00:00.000Z");
    expect(line).toMatch(/Authorizes nothing/);
    expect(formatMissRate(summarizeMissRate([], []))).toMatch(/corpus is empty/);
    expect(formatMissRate(null)).toMatch(/no ledger/);
  });
});

describe("readImpactMissRate", () => {
  it("reads both files under a repo path, treats an absent sidecar as empty, and is null without a ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-ti-rate-"));
    try {
      expect(readImpactMissRate(root)).toBeNull();
      expect(readImpactMissRate(null)).toBeNull();
      mkdirSync(join(root, ".test-impact"), { recursive: true });
      writeFileSync(join(root, OUTCOMES_RELATIVE_PATH), LEDGER.map((r) => JSON.stringify(r)).join("\n") + "\n");
      expect(readImpactMissRate(root)?.tiers.map((t) => [t.tier, t.merges, t.misses])).toEqual([["impact", 3, 0], ["package", 1, 0]]);
      writeFileSync(join(root, MISSES_RELATIVE_PATH), MISSES.map((r) => JSON.stringify(r)).join("\n") + "\n");
      expect(readImpactMissRate(root)).toEqual(summarizeMissRate(LEDGER, MISSES));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
