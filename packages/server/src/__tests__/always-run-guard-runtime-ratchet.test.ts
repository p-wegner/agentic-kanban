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
 *
 * -- Second disclosed movement (2026-09-06, #1038 + #1045) — 549,000 -> 555,000 -------------
 *
 * Two guards arrived with those branches, both at the ASSUMED 3,000 ms:
 *   `cli-path-resolution-guard.test.ts`  — walks `src/cli` for path-taking declarations
 *   `promote-evidence.test.ts`           — imports `scripts/promote-evidence.mjs`
 *
 * The argument for the seconds: neither is optional. The first is the standing guard for the
 * defect #1038 fixed (a relative CLI path silently resolving against `packages/server`), and it
 * cannot import what it checks — it reads the sources. The second's import crosses OUT of this
 * package, which is precisely what `vitest related` cannot follow. Both arrived BARE and were
 * given `when:` territories here rather than left forced onto every diff, which is the fix this
 * ratchet's own message asks for first — it does not move this worst-case number, but it is why
 * the number is not what an ordinary diff pays. Both should shrink at the next `durations.json`
 * capture, when their real cost replaces the placeholder.
 *
 * -- Third disclosed movement (2026-09-07, #1052) — 555,000 -> 558,000 ---------------------
 *
 * `check-arch-scoping.test.mjs`, at the ASSUMED 3,000 ms. The argument for the seconds: it
 * imports `scripts/check-arch.mjs`, a repo script outside every package's `src/` tree, so it is
 * import-graph-invisible in exactly the shape `always-run-marker-ratchet` demands a marker for
 * (the same reason `test-mine-scope-derivation.test.mjs` beside it carries one). It carries a
 * `when:scripts/check-arch.mjs` territory — this ratchet's own doc above says that does not move
 * THIS worst-case number, only what an ordinary diff pays, which is the point #1052 exists to
 * shrink for `check:arch` itself. Should shrink at the next `durations.json` capture.
 */
/*
 * -- Fourth disclosed movement (2026-09-08, #1056 follow-up) — 558,000 -> 561,000 ----------
 *
 * `legacy-temp-prefixes.test.ts`, the 182nd guard, at the ASSUMED 3,000 ms.
 *
 * The argument for the seconds: it pins a rule that DELETES. `sweep-temp-dirs.mjs --legacy`
 * removes un-namespaced `%TEMP%` directories by DERIVED ownership — for every `ak-<X>-` prefix
 * this repo mints today, the bare `<X>-` form came from an older revision of that same call site
 * — and it removed 22,704 of them on its first run. That derivation is what stands between the
 * script and deleting a SIBLING tool's directories (refactor-skill and code-metrics live on the
 * same box), and the specificity filter that declines generic bare forms (`plan`, `ws`, `fork`)
 * is the only thing making the claim safe. A guard on a deletion rule is not one to leave
 * scopeable.
 *
 * It imports `scripts/legacy-temp-prefixes.mjs`, outside every package's `src/` tree, which is
 * the import-graph-invisible shape the marker exists for — the same reason `check-arch-scoping`
 * and `promote-evidence` above carry one. It has a `when:scripts/**` territory, so an ordinary
 * diff pays nothing; per this file's own doc that does not move THIS worst-case number, only
 * what a particular diff pays.
 *
 * Caught by this ratchet on the master sweep (561s against the 558s floor) rather than at review
 * time — the mechanism working, since the marker went in without anyone pricing it. Should
 * shrink at the next `durations.json` capture: measured ~4s wall for three cases, most of it one
 * tree walk.
 */
/*
 * -- Fifth disclosed movement (2026-09-09, #1069) — 561,000 -> 564,000 --------------------
 *
 * `disclose-context-hook-command.test.ts`, the 183rd guard, at the ASSUMED 3,000 ms.
 *
 * The argument for the seconds: it is the standing guard for the defect #1069 fixed — the
 * PostToolUse hook wired as a bare relative path, which Node resolves against the spawned
 * process's actual OS cwd, so a single `cd` disabled context disclosure for the rest of a
 * session with only a non-blocking error to show for it. The guard proves the regression and
 * the fix by SPAWNING the wired command from a subdirectory of a fixture repo, because the
 * string alone is what the previous review passed. A subprocess launched against a fixture tree
 * is invisible to every import graph, so `always-run-marker-ratchet` demands the marker the
 * moment the file lands: the choice was "declared or silently unrun", never "marker or none".
 *
 * It carries a `when:` territory of the wired command and the scaffold that ships it
 * (`.claude/settings.json`, `.claude/hooks/**`, `packages/server/src/scaffold/**`,
 * `services/project-scaffold.ts`), so an ordinary diff pays nothing for it — which, per this
 * file's own doc, does not move THIS worst-case number. Should shrink at the next
 * `durations.json` capture: measured ~1s wall for its four spawn cases.
 */
/*
 * -- Sixth disclosed movement (2026-09-12, #1110 follow-up) — 564,000 -> 567,000 ------------
 *
 * `temp-entry-cap-lockstep.test.ts`, the 184th guard, at the ASSUMED 3,000 ms.
 *
 * The argument for the seconds: it pins a number that a REMEDY restates, and the drift had
 * already done damage. `scripts/sweep-loose-test-db-files.mjs` hard-coded 50,000 as "the
 * pre-merge gate's temp-health floor" and printed "so the gate will keep HOLDING" above it. The
 * real floor is `DEFAULT_TEMP_ENTRY_CAP` = 250,000 — and 50,000 is specifically the value
 * `temp-health.ts` tried FIRST and then refuted by measurement, because it would hold every merge
 * on a box whose `%TEMP%` enumerates in 0.2 s. So the script asserted a blocker that cannot occur,
 * in the authoritative voice of the tool you run to fix things. On 2026-09-12 that line sent an
 * operator investigating a phantom merge hold on a box sitting at ~82,000 entries (a third of the
 * floor), while the actual gate failure lay elsewhere. A wrong number inside a remedy is worse
 * than no remedy: it looks authoritative and it points away from the cause.
 *
 * Why it must be a guard rather than a comment: the two sides CANNOT import each other, for the
 * same packaging reason `always-run-dirs-lockstep.test.ts` documents — `scripts/*.mjs` runs under
 * bare `node` with no build step, and `packages/server` ships only `dist/`. Two implementations
 * is the floor the packaging allows, so the only thing that can hold them together is a test. And
 * it reads the script's SOURCE rather than importing it, because that script performs its whole
 * sweep at import time; an importing guard would enumerate the developer's real `%TEMP%` as a
 * side effect of running the suite. Reading a file outside its own import graph is exactly the
 * shape `always-run-marker-ratchet` demands a marker for, so the choice here was never "marker or
 * no marker", only "declared or silently unrun".
 *
 * It carries a `when:scripts/**,…/lib/temp-health.ts,…/__tests__/helpers/**` territory, so an
 * ordinary diff pays nothing for it — which, per this file's own doc above, does not move THIS
 * worst-case number. Should shrink at the next `durations.json` capture: measured ~0.4s wall for
 * its four cases, against the 3,000 ms placeholder.
 */
/*
 * -- Seventh disclosed movement (2026-09-13, #1113 follow-up) — 567,000 -> 570,000 ----------
 *
 * `quiesce-reconciler-launch-sites.test.ts`, the 185th guard, at the ASSUMED 3,000 ms.
 *
 * The argument for the seconds: #1108 wired the quiesce hold into the two chokepoints every
 * workspace-creating/agent-launching path is SUPPOSED to funnel through, and a `git grep` for
 * `.startSession(` under `startup/` then found FIVE call sites reaching the session manager
 * directly, past both. What must hold is that no NEW direct caller appears — a statement about
 * files this suite never imports, so it reads their text off disk. That is exactly the
 * import-graph-invisible shape `always-run-marker-ratchet` demands a marker for: the choice was
 * never "marker or no marker", only "declared or silently unrun".
 *
 * Its real cost is far under the assumption (4 ms of test time measured; the 3,000 ms is the
 * placeholder every new guard carries until `durations.json` is next captured), so this movement
 * should shrink at the next capture rather than persist.
 *
 * It carries a `when:packages/server/src/startup/**` territory — the single tree it walks, and
 * the whole of it — so an ordinary diff pays nothing for it, which, per this file's own doc
 * above, does not move THIS worst-case number.
 */
/*
 * -- Eighth disclosed movement (2026-09-13, #1126) — 570,000 -> 576,000 ---------------------
 *
 * Two guards arrived with #1126, both at the ASSUMED 3,000 ms:
 *   `pnpm-store-health.test.mjs`      — imports `scripts/pnpm-store-health.mjs`
 *   `prune-worktree-husks.test.mjs`   — imports `scripts/prune-worktree-husks.mjs` (+ `safe-rmdir.mjs`)
 *
 * The argument for the seconds: both scripts live under `scripts/` and no package's `src/`
 * import graph reaches them — exactly the shape `always-run-marker-ratchet` demands a marker
 * for, the same reasoning `safe-rmdir.test.ts`/`check-arch-scoping.test.mjs` already carry.
 * Each pins the pure link-counting / husk-detection core a store-health probe and a
 * dead-worktree pruner need to stay correct, so leaving them unmarked would mean the guard
 * scan silently drops them from every scoped run.
 *
 * Both carry a `when:scripts/*.mjs` territory naming exactly the script(s) they import, so an
 * ordinary diff pays nothing for them — which, per this file's own doc above, does not move
 * THIS worst-case number. Should shrink at the next `durations.json` capture: both suites run
 * in well under 1s (measured via `pnpm exec vitest run` locally), against the 3,000 ms
 * placeholder each carries until then.
 *
 * -- Fourth disclosed movement (2026-09-21, #1146) — 576,000 -> 582,000 --------------------
 *
 * `herdr-hook-adapter.test.ts`, the 188th guard, MEASURED at 5,852 ms (run alone on a loaded
 * box; entered by hand into `durations.json` rather than left at the 3,000 ms placeholder, so
 * the assumed-file count stays at 25). The argument for the seconds: it spawns the live
 * `.herdr/plugin/agentic-kanban-hooks.mjs` adapter and the `.claude/hooks/*.js` scripts it
 * delegates to, outside every package's `src/` — import-graph-invisible in exactly the shape
 * `always-run-marker-ratchet` demands a marker for, and it is the only test proving a herdr-hosted
 * session is held to the same DB-safety / cross-worktree / command-safety gates as the other
 * providers. It carries a `when:` territory of the hook trees it spawns, so an ordinary diff
 * pays nothing for it.
 *
 * -- Ninth disclosed movement (2026-09-22, #1221) — 582,000 -> 585,000 ---------------------
 *
 * `pre-merge-gate-admission-mock-ratchet.test.ts`, the 189th guard, at the ASSUMED 3,000 ms.
 * The argument for the seconds: it re-derives, from source text, which `__tests__` suites
 * invoke the real `runPreMergeGate` and never neutralise the host-admission read
 * (`resolveGateHostAdmission`/`readTier0Capacity`/`probeTempHealth`) — exactly the
 * import-graph-invisible tree-scan shape `always-run-marker-ratchet` demands a marker for, and
 * it is the guard that stops a FOURTH suite regressing the #1221 defect (a unit test that reads
 * the real machine's free memory and fails as "host saturated" on any loaded box). It carries a
 * `when:` territory of the four `__tests__` trees plus the two gate modules its signature is
 * about, so an ordinary diff elsewhere pays nothing for it — which, per this file's own doc
 * above, does not move THIS worst-case number. Should shrink at the next `durations.json`
 * capture; it walks ~190 small test files and is expected to run in well under 1s.
 */
const BASELINE_TOTAL_MS = 585_000;

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
 *
 * Raised 25 -> 26 with #1221's `pre-merge-gate-admission-mock-ratchet.test.ts`, added at the
 * assumed duration (unmeasured until the next `durations.json` capture).
 */
const MAX_ASSUMED_FILES = 26;

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
