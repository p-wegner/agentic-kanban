/**
 * Rebuild the test-impact map after a merge lands (#1046).
 *
 * ## The gap this closes
 *
 * Before this, every refresh trigger asked `impact.mjs check` whether the map was stale and did
 * nothing when it said no. The tool's own rule is `staleWidenAfterCommits` = 30, so a map measured
 * 23-24 commits behind on this board was "fresh" to every one of those triggers — and the moment it
 * tipped past 30 the selection silently WIDENED to the package tier, i.e. the gate got slower for a
 * reason that looks like nothing changed. Merges are what move HEAD, so a merge is the event that
 * makes the map stale, and it was the one event nothing was listening to.
 *
 * ## The bound
 *
 * This trigger applies its own, tighter threshold — {@link IMPACT_MAP_MAX_COMMITS_BEHIND} — instead
 * of deferring to the tool's. It counts `<map stamp>..HEAD` itself (the stamp is in the map's first
 * few hundred bytes; {@link readImpactMapStamp} already reads it for the gate memo key) and forces
 * a rebuild past that number. So the guarantee this file exists to provide is statable rather than
 * "eventually": **after a merge completes, the map is at most `IMPACT_MAP_MAX_COMMITS_BEHIND`
 * commits behind that project's HEAD.**
 *
 * Below the bound it still runs the ordinary pass, which asks the tool — a merge that ADDS a test
 * file makes the map stale at one commit behind, and the tool is what sees that.
 *
 * ## Where it runs, and why that is still single-writer
 *
 * From the lock-free tail of `runWorkspacePostMergeCleanup`, against the project's `repoPath` — the
 * MAIN CHECKOUT, never the worktree — and only after `onMainCheckoutSettled` has fired, so the
 * deferred working-tree sync is done and the per-repo merge lock is released. The pass itself takes
 * the queue repo lock with a short timeout and SKIPS on contention, so a merge train's next landing
 * is never held behind a rebuild; the sweep picks that project up within 15 minutes.
 *
 * It is placed BEFORE the auto-start steps for the same reason the monitor phase sits before
 * `runAutoStart`: a builder launched by this merge's dependency cascade gets the map copied into its
 * worktree at provisioning, and it should be the one that includes the merge that just landed.
 *
 * Cost: one `impact.mjs check` (~a node startup) per merge, plus a ~7.4s rebuild on the merges that
 * are actually past the bound. Both sit in a chain that already runs code metrics and, when
 * enabled, polls a learning session to completion.
 */
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

import {
  resolveTestImpactMapGate,
  runTestImpactMapPass,
  type ImpactMapPassDeps,
  type ImpactMapResult,
} from "../test-impact-map.service.js";
import { readImpactMapStamp } from "../test-impact-selector-id.js";

/**
 * How far behind HEAD the map may be once a merge has completed (#1046).
 *
 * Well under the skill's own `staleWidenAfterCommits` (30), because the tool's threshold is the
 * point at which the selection stops being usable — a bound set THERE guarantees only that the gate
 * is about to widen. Ten leaves real headroom while keeping the rebuild off most merges: this repo
 * lands a handful of commits per branch, so a merge typically finds the map a few commits behind and
 * costs one `check` spawn.
 */
export const IMPACT_MAP_MAX_COMMITS_BEHIND = 10;

export type PostMergeImpactMapOutcome =
  | "gate_off"
  | "no_project"
  | "pass"
  | "failed";

export interface PostMergeImpactMapResult {
  outcome: PostMergeImpactMapOutcome;
  /** Commits between the map's stamp and HEAD, or null when it could not be counted. */
  commitsBehind: number | null;
  /** Whether the tool's freshness check was bypassed because the bound was exceeded. */
  forced: boolean;
  /** The pass's own result, when it ran. */
  pass?: ImpactMapResult;
  detail?: string;
}

/**
 * Count `<map stamp>..HEAD` in a main checkout. Null means "cannot be counted", never zero.
 *
 * Every unknown resolves to null on purpose, and null does NOT force a rebuild: an absent map, a
 * stamp that is not an ancestor (a rebuilt-elsewhere or rewritten history), and a git failure are
 * all cases where the tool's own `check` gives the better answer — it reports "no map" and "stamp
 * unreachable" as stale in their own right. Guessing `Infinity` here would rebuild on every merge
 * of every project that has no map at all.
 */
export async function countImpactMapCommitsBehind(repoPath: string): Promise<number | null> {
  const stamp = readImpactMapStamp(repoPath);
  if (stamp === "absent") return null;
  const res = await gitExec(["rev-list", "--count", `${stamp}..HEAD`], { cwd: repoPath });
  if (!execSucceeded(res)) return null;
  const count = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

export interface PostMergeImpactMapInput {
  /** The project's MAIN CHECKOUT. A worktree path here would break single-writer. */
  repoPath: string | null | undefined;
  projectId: string | null | undefined;
  /** The pref map the merge chain already loaded — no second read, no second generation. */
  prefMap: Map<string, string>;
  /** The bound to apply; defaults to {@link IMPACT_MAP_MAX_COMMITS_BEHIND}. */
  maxCommitsBehind?: number;
  /** Injected for tests; forwarded to the pass. */
  passDeps?: ImpactMapPassDeps;
  log?: (message: string) => void;
}

/**
 * Refresh a project's map now that a merge has landed. Never throws — this runs inside the
 * best-effort post-merge tail, where a failed test-selection optimisation must never be able to
 * strand a merged workspace.
 */
export async function refreshImpactMapAfterMerge(
  input: PostMergeImpactMapInput,
): Promise<PostMergeImpactMapResult> {
  const log = input.log ?? ((message: string) => console.log(`[test-impact-map] ${message}`));
  const { repoPath, projectId } = input;
  if (!repoPath || !projectId) return { outcome: "no_project", commitsBehind: null, forced: false };

  // Same gate as every other trigger — `test_impact_map_<projectId>` over the board-wide
  // `test_impact_map_refresh` — resolved through the shared resolver so there is ONE answer to
  // "may this project's map be rebuilt" rather than a second one growing here.
  if (!resolveTestImpactMapGate(input.prefMap, projectId, getBool(input.prefMap, "test_impact_map_refresh")).enabled) {
    return { outcome: "gate_off", commitsBehind: null, forced: false };
  }

  const bound = input.maxCommitsBehind ?? IMPACT_MAP_MAX_COMMITS_BEHIND;
  try {
    const commitsBehind = await countImpactMapCommitsBehind(repoPath);
    const forced = commitsBehind !== null && commitsBehind > bound;
    const pass = await runTestImpactMapPass(repoPath, { ...input.passDeps, forceRebuild: forced });

    if (pass.outcome === "rebuilt") {
      log(
        `rebuilt after merge for project ${projectId} @ ${pass.headSha}`
          + (forced ? ` (was ${commitsBehind} commits behind, bound ${bound})` : " (tool reported it stale)"),
      );
    } else if (pass.outcome !== "fresh") {
      // `fresh` is the steady state and the common case; everything else names something an
      // operator may have to act on (a still-tracked map, a build failure), and staying silent
      // about it is precisely how a map stops refreshing without anyone noticing.
      log(
        `not refreshed after merge for project ${projectId}: ${pass.outcome}`
          + (pass.detail ? ` - ${pass.detail}` : ""),
      );
    }
    return { outcome: "pass", commitsBehind, forced, pass };
  } catch (err) {
    return { outcome: "failed", commitsBehind: null, forced: false, detail: errorMessage(err) };
  }
}
