#!/usr/bin/env node
/**
 * pnpm-store health probe (#1126).
 *
 * Every worktree install hard-links into the ONE shared pnpm store (`~/.pnpm-store` by
 * default). NTFS caps a file at 1024 hard links; the small stub files that appear in dozens of
 * packages per install (`export {};`, empty `.d.ts` shims, ...) accumulate links fastest and hit
 * that ceiling first. Once a file is at the ceiling, the NEXT install that would hard-link it
 * fails with `code=UNKNOWN errno=-4094 syscall=link` — an error indistinguishable, at a glance,
 * from unrelated store corruption (see CONTINUE.md's `ERROR_FILE_CORRUPT` incident). This script
 * counts links per file so the ceiling is a WARNING before it is a failure, not after.
 *
 * Usage:
 *   node scripts/pnpm-store-health.mjs [storeDir] [--warn-threshold=900] [--json] [--fail-on-warn]
 *
 *   storeDir          defaults to ~/.pnpm-store
 *   --warn-threshold  link count at which a file is reported (default 900; NTFS hard caps at 1024)
 *   --json            one machine-readable result line
 *   --fail-on-warn     exit 1 when any offender is found (default: probe only, always exits 0
 *                      unless it hits an I/O error)
 *
 * Plain node, no package resolution — it must work even when the tree it is checking is under
 * install-time stress.
 *
 * Escape hatch, held in reserve: setting `package-import-method=copy` in `.npmrc` makes pnpm
 * copy files into each project instead of hard-linking them, which removes the NTFS ceiling
 * entirely — at real extra disk usage and slower installs. Prefer pruning dead worktrees
 * (`scripts/prune-worktree-husks.mjs`) first; this probe exists so the ceiling is seen coming
 * rather than discovered as an install failure.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const NTFS_HARD_LINK_CAP = 1024;

/**
 * Pure function — walks `storeDir` and counts hard links per file.
 * Returns { checked, offenders, hardCap } where offenders is every file at or above
 * `warnThreshold`, sorted by link count descending. Never throws on an unreadable subtree —
 * it is skipped, since a probe must not itself become an install-blocking failure.
 */
export function checkStoreHealth(storeDir, { warnThreshold = 900 } = {}) {
  const offenders = [];
  let checked = 0;
  const stack = [resolve(storeDir)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      checked++;
      if (st.nlink >= warnThreshold) offenders.push({ file: full, links: st.nlink });
    }
  }
  offenders.sort((a, b) => b.links - a.links);
  return { ok: offenders.length === 0, checked, offenders, hardCap: NTFS_HARD_LINK_CAP };
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const failOnWarn = args.includes("--fail-on-warn");
  const thresholdArg = args.find((a) => a.startsWith("--warn-threshold="));
  const warnThreshold = thresholdArg ? Number(thresholdArg.slice("--warn-threshold=".length)) : 900;
  const positional = args.find((a) => !a.startsWith("--"));
  const storeDir = resolve(positional ?? join(homedir(), ".pnpm-store"));

  const result = checkStoreHealth(storeDir, { warnThreshold });

  if (json) {
    console.log(JSON.stringify({ storeDir, warnThreshold, ...result }));
  } else if (result.ok) {
    console.log(`pnpm-store-health: OK — ${result.checked} file(s) checked in ${storeDir}, none at or above ${warnThreshold} links (cap ${result.hardCap}).`);
  } else {
    console.warn(`pnpm-store-health: WARNING — ${result.offenders.length} file(s) in ${storeDir} at or above ${warnThreshold} links (cap ${result.hardCap}):`);
    for (const o of result.offenders.slice(0, 20)) {
      console.warn(`  ${o.links}${o.links >= result.hardCap ? " (AT CEILING)" : ""}  ${o.file}`);
    }
    console.warn("A file at the ceiling makes the NEXT install that hard-links it fail with errno=-4094 syscall=link. Prune dead worktrees (scripts/prune-worktree-husks.mjs) to release links, or set package-import-method=copy in .npmrc to remove the ceiling entirely (real disk/install-time cost).");
  }
  return failOnWarn && !result.ok ? 1 : 0;
}

if (process.argv[1] && /pnpm-store-health\.mjs$/i.test(process.argv[1])) {
  process.exit(main(process.argv));
}
