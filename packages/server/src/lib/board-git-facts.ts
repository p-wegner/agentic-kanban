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

/** Merges on master since LOCAL midnight — the same boundary and source as `git log --merges --since=midnight`. */
export function countMergesSince(sinceIso: string): number | null {
  for (const ref of ["master", "origin/master", "HEAD"]) {
    const out = git(["rev-list", "--merges", "--count", `--since=${sinceIso}`, ref]);
    if (out && /^\d+$/.test(out)) return Number(out);
  }
  return null;
}

export function resolveBoardGitFacts(nowMs: number = Date.now()): { tag: string | null; mergedToday: number | null; unpromotedMerges: number | null } {
  if (cached && nowMs - cached.at < CACHE_MS) return cached;
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"])?.split("\n")[0] || null;
  // #1449: merges on master the running stable tag does not contain ("N merges not yet promoted").
  let unpromotedMerges: number | null = null;
  if (tag) {
    for (const ref of ["master", "origin/master"]) {
      const out = git(["rev-list", "--merges", "--count", `${tag}..${ref}`]);
      if (out && /^\d+$/.test(out)) { unpromotedMerges = Number(out); break; }
    }
  }
  cached = { at: nowMs, tag, mergedToday: countMergesSince(midnight.toISOString()), unpromotedMerges };
  return cached;
}
