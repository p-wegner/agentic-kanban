#!/usr/bin/env node
/**
 * Drain the board's leaked `%TEMP%` fixture directories (#364).
 *
 * Two mechanisms, deliberately separate:
 *
 * - The vitest `globalSetup` sweep
 *   (`packages/server/src/__tests__/helpers/reap-fixture-child-servers.ts`) keeps the STEADY
 *   STATE: it runs before and after every server test run and is capped so it can never add
 *   minutes to the front of a run.
 * - This script drains the BACKLOG. Measured when #364 was filed: 8,448 `kanban-*` directories
 *   spanning a month, plus ~17,000 `ak-*`. At the capped rate that is dozens of test runs, so
 *   the one-off cleanup gets its own uncapped entry point instead of being smuggled into the
 *   test bootstrap.
 *
 * Usage:
 *   node scripts/sweep-temp-dirs.mjs            # dry run — count only, removes nothing
 *   node scripts/sweep-temp-dirs.mjs --apply    # remove them
 *   node scripts/sweep-temp-dirs.mjs --apply --older-than-hours 24
 *
 * Safety: only the board's own `kanban-*` / `ak-*` directory namespaces are ever considered,
 * only directories (never `kanban-session-*.out` transcripts the running server reads), and only
 * entries older than the age cutoff (default 2h) so a concurrently running suite — including one
 * in another worktree of this repo — is never touched.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMESPACES = ["kanban-", "ak-"];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const hoursIdx = args.indexOf("--older-than-hours");
const olderThanHours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 2;
if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
  console.error("--older-than-hours must be a non-negative number");
  process.exit(2);
}

const root = tmpdir();
const cutoff = Date.now() - olderThanHours * 60 * 60_000;

console.log(`[temp-sweep] scanning ${root} (this can take a while — %TEMP% held ~247,000 entries when #364 was filed)`);
const started = Date.now();
let entries;
try {
  entries = readdirSync(root);
} catch (err) {
  console.error(`[temp-sweep] cannot read ${root}: ${err.message}`);
  process.exit(1);
}
console.log(`[temp-sweep] ${entries.length} entries enumerated in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const byNamespace = new Map(NAMESPACES.map((ns) => [ns, { matched: 0, removed: 0, failed: 0, tooNew: 0 }]));
for (const name of entries) {
  const ns = NAMESPACES.find((prefix) => name.startsWith(prefix));
  if (!ns) continue;
  const tally = byNamespace.get(ns);
  const full = join(root, name);
  let st;
  try {
    st = statSync(full);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  if (st.mtimeMs >= cutoff) { tally.tooNew++; continue; }
  tally.matched++;
  if (!apply) continue;
  try {
    rmSync(full, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
    tally.removed++;
  } catch {
    // #352's root cause: a surviving grandchild process holding the dir as its cwd. Reported
    // rather than retried forever — the next run picks it up once that process is gone.
    tally.failed++;
  }
}

for (const [ns, t] of byNamespace) {
  console.log(
    `[temp-sweep] ${ns}*  eligible=${t.matched}  removed=${t.removed}  failed=${t.failed}  younger-than-cutoff=${t.tooNew}`,
  );
}
if (!apply) console.log("[temp-sweep] dry run — pass --apply to remove");
