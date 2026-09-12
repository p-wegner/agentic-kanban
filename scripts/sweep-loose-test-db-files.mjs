#!/usr/bin/env node
/**
 * Drain the board's leaked loose `test-db-*.db` files from `%TEMP%` (#843).
 *
 * `createTestDb()` (`packages/server/src/__tests__/helpers/test-db.ts`) used to mint each
 * scratch DB directly in `%TEMP%` as `test-db-<uuid>.db` (+ `-wal`/`-shm` siblings). #840
 * moved that into a per-process `ak-test-db-*` DIRECTORY, which `reap-fixture-child-servers.ts`
 * (and this repo's sibling `sweep-temp-dirs.mjs`) can sweep — but both sweeps are gated on
 * `statSync(...).isDirectory()`, so a LOOSE FILE was never in reach and never will be, however
 * old it gets. Measured when #843 was filed: 518,581 `test-db-*` entries in `%TEMP%`, 0 of them
 * directories. This script is the one-off that drains that pre-#840 backlog; it is not meant to
 * run again once the count reaches zero, and #840's fix means it shouldn't need to.
 *
 * Usage:
 *   node scripts/sweep-loose-test-db-files.mjs            # dry run — count + bytes only
 *   node scripts/sweep-loose-test-db-files.mjs --apply    # remove them
 *
 * Safety:
 * - Matches only `test-db-<uuid>.db` (and its `-wal`/`-shm`/`-journal` siblings) — a UUID-shaped
 *   suffix, not a prefix match — so it can never touch `test-db-template-<hash>.db`, the
 *   persistent migrated-schema cache #535 built and #840's own comments warn against deleting
 *   (a hit costs a full 121-migration replay on the next test run).
 * - Skips anything that is a directory (the `ak-test-db-*` namespace the reaper already owns).
 * - Per-file failures (a file held open by a concurrently running test suite, on this or another
 *   worktree) are counted and reported, never fatal to the run.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * ANY prefix, not just `test-db-` (#1056).
 *
 * #843 wrote this to drain one prefix, because one prefix was what had been measured. The shape
 * it was really draining is "a scratch SQLite file named by a fresh uuid", and other suites mint
 * exactly that under their own names — measured in `%TEMP%` while #1056 was worked:
 * `manual-migrate-test-`, `project-cascade-completeness-`, `dedup-same-root-`,
 * `leaked-temp-cleanup-`, `test-issues-`, none of them matched by a `test-db-`-anchored regex,
 * and two of them still being minted daily. The pre-merge gate's temp-health hold now names this
 * script as the remedy, and a remedy that does not drain the actual backlog is worse than none.
 *
 * The safety argument is unchanged, and is what makes the widening sound: the discriminator is
 * the UUID-shaped SUFFIX, never the prefix. `test-db-template-<hash>.db` — the persistent
 * migrated-schema cache #535 built, whose loss costs a full migration replay — carries a HASH,
 * not a uuid, so it does not match and cannot. Nor does any hand-named file left here.
 */
const LOOSE_SCRATCH_DB_RE = new RegExp(`^[A-Za-z0-9._-]*${UUID_RE}\\.db(-wal|-shm|-journal)?$`, "i");

const args = process.argv.slice(2);
const apply = args.includes("--apply");

/**
 * The pre-merge gate's temp-health floor, MIRRORED from `DEFAULT_TEMP_ENTRY_CAP` in
 * `packages/server/src/lib/temp-health.ts`. Held in lockstep with it by
 * `packages/server/src/__tests__/temp-entry-cap-lockstep.test.ts`, which reads this file's
 * source — this script runs its whole sweep at import time, so a guard must never import it.
 *
 * Two implementations is the floor the packaging allows, exactly as `always-run-dirs-lockstep`
 * documents: this script is run by bare `node` with no build step, and `packages/server` ships
 * only `dist/`, so neither side can import the other's constant.
 *
 * Why this exists at all: the epilogue used to hard-code 50,000 and tell the operator "the gate
 * will keep HOLDING". The real floor is 250,000 — and 50,000 is the value a first draft of
 * `temp-health.ts` used and then REFUTED by measurement, because it would hold every merge on a
 * box whose `%TEMP%` enumerates in 0.2 s. So the message asserted a blocker that cannot occur and
 * sent at least one operator hunting a phantom hold. A number restated from another module is a
 * number that drifts; this one is now pinned.
 */
const GATE_TEMP_ENTRY_CAP =
  Number(process.env.KANBAN_TEMP_ENTRY_CAP) > 0 ? Number(process.env.KANBAN_TEMP_ENTRY_CAP) : 250_000;

const root = tmpdir();

console.log(`[test-db-sweep] scanning ${root} (this can take a while on a heavily populated %TEMP%)`);
const started = Date.now();
let entries;
try {
  entries = readdirSync(root);
} catch (err) {
  console.error(`[test-db-sweep] cannot read ${root}: ${err.message}`);
  process.exit(1);
}
console.log(`[test-db-sweep] ${entries.length} entries enumerated in ${((Date.now() - started) / 1000).toFixed(1)}s`);

let matched = 0;
let removed = 0;
let failed = 0;
let bytes = 0;

for (const name of entries) {
  if (!LOOSE_SCRATCH_DB_RE.test(name)) continue;
  const full = join(root, name);
  let st;
  try {
    st = statSync(full);
  } catch {
    continue;
  }
  if (st.isDirectory()) continue; // never touch the ak-test-db-* namespace the reaper owns
  matched++;
  bytes += st.size;
  if (!apply) continue;
  try {
    rmSync(full, { force: true, maxRetries: 1, retryDelay: 50 });
    removed++;
  } catch {
    // Held open by a live test run, on this or another worktree. Counted, not retried —
    // the next sweep picks it up once the holder is gone.
    failed++;
  }
}

const mb = (bytes / (1024 * 1024)).toFixed(1);
console.log(`[test-db-sweep] matched=${matched} (~${mb} MB)  removed=${removed}  failed=${failed}`);
if (!apply) console.log("[test-db-sweep] dry run — pass --apply to remove");

// State the REMAINDER, not only the part this script owns (#1056). The output used to end at
// "removed=N", which reads as "done" — but the pre-merge gate's temp-health hold is decided by
// the TOTAL entry count, so a run that cleared its own families and left 90,000 directories
// behind would leave the operator believing the remedy had worked while every merge kept
// holding. Silence about the remainder is how a capped sweep looks identical to a finished one,
// which is the same defect the fixture reaper's "more remain for the next run" line had.
const remaining = entries.length - removed;
console.log(
  `[test-db-sweep] ${remaining} entries remain in ${root}`
  + (remaining >= GATE_TEMP_ENTRY_CAP
    ? ` — ABOVE the pre-merge gate's temp-health floor (${GATE_TEMP_ENTRY_CAP}), so the gate will`
      + " HOLD. What is left is mostly directories, which this script deliberately never touches:"
      + " sweep those with scripts/sweep-temp-dirs.mjs."
    : ` — below the pre-merge gate's temp-health floor (${GATE_TEMP_ENTRY_CAP}), so the gate`
      + " admits. A large remainder here is untidy, not a merge blocker; the reaper's own"
      + " 50,000-entry line is an EARLY WARNING well below that floor, not a hold."),
);
