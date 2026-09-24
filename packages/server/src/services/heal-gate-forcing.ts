/**
 * The failing suites a HEAL workspace's gate must run (#1239, decision 019 part 2).
 *
 * A heal ticket's workspace is based on a red release candidate. Its pre-merge gate runs the
 * same narrow selection as any builder's — and the suites the rc sweep found red are exactly
 * what the narrow selection can rank OUT: a suite that failed for a reason outside the diff's
 * import graph (an environment, a tree-walking guard, a flake the fix targets) has no edge to
 * the changed files. So the rc's recorded failing suites are forced into the run through the
 * same door an ADDED test file already uses (`KANBAN_TEST_NEW_FILES`, `resolveImpactSelectorEnv`):
 * "run these regardless of what the selection ranked".
 *
 * Keyed on the WORKSPACE BASE, not the ticket: every workspace based on an `rc/…` branch is
 * healing that candidate, whatever ticket it serves, and the merge-back workspace (base master)
 * is deliberately not one of them — its gate measures the whole candidate against master.
 *
 * Only suites that exist in the worktree are named: a suite the fix DELETED must not be handed
 * to vitest, which would fail the package with `No test files found` (the same rule the
 * new-files door applies).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { decodeFailedSuites, getLatestBaseBranchHealth, RC_HEALTH_BRANCH_PREFIX } from "../repositories/base-branch-health.repository.js";
import { canonicalFailedSuites } from "../lib/heal-failure-signature.js";

export function isRcBranch(branch: string | null | undefined): boolean {
  return typeof branch === "string" && branch.startsWith(RC_HEALTH_BRANCH_PREFIX);
}

/**
 * Repo-relative suite paths to force for a workspace, or `[]` for one not based on an rc, an rc
 * with no red verdict, or a read that failed (best-effort — a gate must never refuse over this).
 */
export async function resolveHealForcedSuites(
  args: { projectId: string; baseBranch: string | null | undefined; workingDir: string | null | undefined },
  database: Database = db,
): Promise<string[]> {
  if (!isRcBranch(args.baseBranch) || !args.workingDir) return [];
  try {
    const latest = await getLatestBaseBranchHealth(args.projectId, database, { branch: args.baseBranch });
    if (!latest || latest.outcome !== "red") return [];
    const workingDir = args.workingDir;
    return canonicalFailedSuites(decodeFailedSuites(latest.failedSuites)).filter((suite) => existsSync(join(workingDir, suite)));
  } catch {
    return [];
  }
}
