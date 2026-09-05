// @gate:always-run when:packages/shared/__tests__/**,packages/server/src/__tests__/**,packages/mcp-server/src/__tests__/**,packages/client/src/__tests__/**,scripts/test-mine.mjs,docs/tests/durations.json
// — re-derives the marker-derived guard set from the repo tree and reads the committed durations
// report; imports nothing it checks (#1042). Territory (#1041): a marker can only be added in a
// package's `__tests__` tree, the scan rule lives in `scripts/test-mine.mjs`, and the numbers come
// from `docs/tests/durations.json`.
import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  ASSUMED_GUARD_MS,
  alwaysRunFloor,
  readTestDurations,
} from "../../../../scripts/test-mine.mjs";

/**
 * #1042 — the always-run set was ratcheted by COUNT, and the cost that matters is TIME.
 *
 * `always-run-marker-ratchet.test.ts` asks whether a suite that reaches outside its import graph
 * carries a marker. Nothing asked what the marker COSTS. Measured 2026-09-05 at the `impact`
 * tier on a 9-file branch: the selection was 1 file / ~3s and this floor was 177 files / ~546s,
 * i.e. ~99.5% of the gate's test cost sat in the half no ratchet watched. A marker added to a 50s
 * suite is a 50s decision taken on every gate run forever, and it should read as one at review
 * time.
 *
 * So this ratchets the summed estimated runtime of the UNCONDITIONAL floor — every marked suite,
 * ignoring `when:` preconditions (#1041). That is the right subject: a precondition narrows what
 * a PARTICULAR diff pays, while the marker itself is what the repo commits to for every diff that
 * cannot narrow.
 *
 * Shrink-only, the same grandfathering shape as every other ratchet here: over the baseline is a
 * regression, and materially UNDER it is staleness — a baseline that is never lowered stops being
 * a ratchet and becomes a budget.
 */

/**
 * Summed estimated wall clock of every `@gate:always-run` suite, in ms.
 *
 * Measured 2026-09-05 from the committed `docs/tests/durations.json`: 177 files, 545,748 ms,
 * of which 15 had no measured duration and were counted at {@link ASSUMED_GUARD_MS}. (176 files
 * / 542,748 ms before this suite itself, which is the mechanism working on its own author: the
 * 177th guard is this ratchet, and it had to argue for its own 3s.)
 *
 * **To RAISE this you must have an argument for the seconds, not just for the marker.** Prefer
 * giving the new suite a `when:` precondition (#1041) — that does not lower this number, but it
 * is what stops the number being paid on every diff. To LOWER it: retire or speed up a guard,
 * then set this to the new total.
 *
 * -- First disclosed movement (2026-09-06, #1050) — 546,000 -> 549,000 --------------------
 *
 * `base-health-probe-temp-cleanup.test.ts`, the 178th guard, counted at the ASSUMED 3,000 ms.
 * The argument for the seconds: two of its four cases read
 * `services/base-branch-health.service.ts` off disk instead of importing it, which is precisely
 * the import-graph-invisible shape the marker exists for — `always-run-marker-ratchet` demanded
 * the marker the moment the file landed, so the choice was never "marker or no marker", only
 * "declared or silently unrun". Its real cost is far under the assumption (8 ms of test time
 * measured; the 3,000 ms is the placeholder every new guard carries until `durations.json` is
 * next captured), so this movement should shrink at the next capture rather than persist.
 * It carries a `when:` territory of the two source trees it reads, so an ordinary diff does not
 * pay it at all — which is what the precondition buys, even though this number cannot show it.
 */
const BASELINE_TOTAL_MS = 549_000;

/**
 * How far under the baseline is tolerated before it counts as stale.
 *
 * Not zero, because `durations.json` is re-captured by hand and its times move a little with the
 * machine they were captured on; a ratchet that fails on measurement noise gets its baseline
 * bumped rather than read. 30s is comfortably under the smallest guard worth retiring.
 */
const STALE_SLACK_MS = 30_000;

/**
 * Ceiling on how many guard suites may be counted at the ASSUMED duration.
 *
 * Not shrink-only, deliberately: a newly-added guard is absent from `durations.json` until the
 * report is next captured, so a zero-growth rule would make every new guard require a ~15-minute
 * full-suite re-capture in the same commit. What must not happen is the total quietly becoming
 * mostly guesswork — hence a ceiling rather than a freeze. Measured at 15 when this landed.
 */
const MAX_ASSUMED_FILES = 25;

const REPO_ROOT = path.resolve(import.meta.dirname!, "..", "..", "..", "..");

interface Floor {
  count: number;
  estMs: number;
  assumedCount: number;
  files: { file: string; ms: number; assumed: boolean }[];
}

function floor(): Floor {
  return alwaysRunFloor({
    root: REPO_ROOT,
    durations: readTestDurations(REPO_ROOT),
  }) as Floor;
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

describe("always-run guard RUNTIME ratchet (#1042)", () => {
  it("the summed estimated runtime of the always-run set stays at or below its baseline", () => {
    const current = floor();
    // Never let a missing/unreadable durations report pass vacuously: without it every file is
    // assumed and the total collapses to `count * 3s`, which would read as a huge improvement.
    expect(
      current.assumedCount,
      `every guard suite was counted at the assumed ${ASSUMED_GUARD_MS}ms — docs/tests/durations.json ` +
        `is missing or unreadable, so this ratchet would be measuring nothing. Re-capture it with ` +
        `\`pnpm test:durations\`.`,
    ).toBeLessThan(current.count);

    const heaviest = current.files
      .slice(0, 10)
      .map((f) => `  ${seconds(f.ms).padStart(6)} ${f.file}${f.assumed ? " (assumed — unmeasured)" : ""}`)
      .join("\n");

    expect(
      Math.round(current.estMs),
      `The @gate:always-run floor grew to ${current.count} suite(s) / ~${seconds(current.estMs)} ` +
        `(baseline ~${seconds(BASELINE_TOTAL_MS)}), of which ${current.assumedCount} are counted at ` +
        `the assumed ${ASSUMED_GUARD_MS}ms.\n` +
        `This is time added to EVERY gate run that cannot narrow, forever. The heaviest suites in ` +
        `the set are:\n${heaviest}\n` +
        `Fixes, in preference order: give the new marker a \`when:\` precondition (#1041) so it is ` +
        `only forced for diffs it can be affected by; make the suite cheaper; or retire a guard the ` +
        `new one subsumes (see docs/tests/guard-inventory.md). Raising BASELINE_TOTAL_MS is the last ` +
        `resort and needs an argument for the seconds.`,
    ).toBeLessThanOrEqual(BASELINE_TOTAL_MS);
  });

  it("the baseline is not stale — a shrunk floor must be pinned at its new total", () => {
    const current = floor();
    expect(
      Math.round(current.estMs),
      `The always-run floor is now ~${seconds(current.estMs)}, well under the pinned ` +
        `~${seconds(BASELINE_TOTAL_MS)}. Lower BASELINE_TOTAL_MS to ${Math.round(current.estMs)} — a ` +
        `baseline that is never lowered is a budget, not a ratchet.`,
    ).toBeGreaterThan(BASELINE_TOTAL_MS - STALE_SLACK_MS);
  });

  it("the estimate does not silently become guesswork", () => {
    const current = floor();
    const assumed = current.files.filter((f) => f.assumed).map((f) => `  ${f.file}`).join("\n");
    expect(
      current.assumedCount,
      `${current.assumedCount} of ${current.count} guard suites have no measured duration and are ` +
        `counted at ${ASSUMED_GUARD_MS}ms each, so the ~${seconds(current.estMs)} total UNDERSTATES ` +
        `the real floor by however much they actually cost. Re-capture with \`pnpm test:durations\` ` +
        `and commit docs/tests/durations.json.\n${assumed}`,
    ).toBeLessThanOrEqual(MAX_ASSUMED_FILES);
  });
});
