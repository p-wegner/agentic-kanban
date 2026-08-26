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
const LOOSE_TEST_DB_RE = new RegExp(`^test-db-${UUID_RE}\\.db(-wal|-shm|-journal)?$`, "i");

const args = process.argv.slice(2);
const apply = args.includes("--apply");

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
  if (!LOOSE_TEST_DB_RE.test(name)) continue;
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
