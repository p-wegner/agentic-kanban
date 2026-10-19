// Git facts the operator console (`status --watch`, #1421/#1424) shows in its header and
// MERGED TODAY line. Db-free, cached briefly: the console polls every 2-5 s.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

const CACHE_MS = 15_000;
const here = dirname(fileURLToPath(import.meta.url));
let cached: { at: number; tag: string | null; mergedToday: number | null; unpromotedMerges: number | null } | undefined;

function git(args: string[]): string | null {
  try { return gitExecSync(args, { cwd: here, timeout: 5000 }).trim(); } catch { return null; }
}

/** Merges on master since `sinceIso` (the console passes now - 24 h). */
export function countMergesSince(sinceIso: string): number | null {
  for (const ref of ["master", "origin/master", "HEAD"]) {
    const out = git(["rev-list", "--merges", "--count", `--since=${sinceIso}`, ref]);
    if (out && /^\d+$/.test(out)) return Number(out);
  }
  return null;
}

export function resolveBoardGitFacts(nowMs: number = Date.now()): { tag: string | null; mergedToday: number | null; unpromotedMerges: number | null } {
  if (cached && nowMs - cached.at < CACHE_MS) return cached;
  // #1620: a rolling 24 h window; a calendar day reset to 0 at midnight right after a busy day.
  const dayAgo = new Date(nowMs - 24 * 3600 * 1000);
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"])?.split("\n")[0] || null;
  // #1449: merges on master the running stable tag does not contain ("N merges not yet promoted").
  let unpromotedMerges: number | null = null;
  if (tag) {
    for (const ref of ["master", "origin/master"]) {
      const out = git(["rev-list", "--merges", "--count", `${tag}..${ref}`]);
      if (out && /^\d+$/.test(out)) { unpromotedMerges = Number(out); break; }
    }
  }
  cached = { at: nowMs, tag, mergedToday: countMergesSince(dayAgo.toISOString()), unpromotedMerges };
  return cached;
}
