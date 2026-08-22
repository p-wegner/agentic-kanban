import { existsSync } from "node:fs";
import { samePath as sharedSamePath } from "@agentic-kanban/shared/lib/path-key";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import type { Database } from "../db/index.js";

/**
 * #361 (Observation C, second half) — a git worktree left registered after its unit merged, which
 * NO existing sweeper can see.
 *
 * MEASURED on kassenbuch (`agentic-kanban-testprojects`), 2026-08-08 run:
 *
 * ```
 * $ git worktree list
 * …/kassenbuch                    c747e8e [master]
 * …/.worktrees/ak-12  57338c4 [feature/ak-12-qa-datum-wird-als-iso-2026-03-15-angezei]
 * …/.worktrees/ak-6   401341b [feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel]
 * ```
 *
 * Both are orphans, and BOTH were invisible to every existing cleanup path:
 * - `pruneStaleWorktrees` (`startup-tasks.ts`), `listStaleWorktrees`/`removeStaleWorktree`
 *   (`workspace-cleanup.service.ts`), the `cleanup_project` MCP tool and `pnpm cli -- cleanup` all
 *   start from `workspaces WHERE status='closed' AND working_dir IS NOT NULL`. Every one of the
 *   project's 20 workspace rows had `working_dir = null`, because finishing a merge nulls it
 *   (`finalizeMergeCleanup` → `clearWorkspaceWorkingDir`). So the DB-driven sweepers are
 *   structurally blind to exactly the worktrees a completed merge leaves behind.
 * - `.worktrees/ak-6` is worse than stale: it is on `…-skel` (slug B), a branch "created from
 *   master" at the pre-work commit that never received the work, while the branch that DID carry
 *   the work and merged was `…-skele` (slug A) and is deleted. No workspace row references branch
 *   B at all, so not even a branch-keyed lookup would find it.
 *
 * The consequence is not cosmetic: an orphaned/dirty checkout state blocks every auto-merge on the
 * project (`getDirtyMainFiles` / the `dirty_main` merge skip).
 *
 * This reconciler therefore works from GIT TRUTH — `git worktree list` — and asks the DB only
 * whether something still claims each entry. That inverts the failing predicate: a nulled
 * `working_dir` now makes a worktree MORE visible, not invisible.
 *
 * It is deliberately conservative. Anything holding work that has not landed is reported and kept;
 * only a worktree that nothing claims AND that carries nothing unshipped is removed. `removeWorktree`
 * adds its own hard guard (it refuses any path not strictly inside `.worktrees/`).
 *
 * ## Where the claim question is answered (#735)
 *
 * The removal now goes through the ONE guard, `removeWorktreeUnlessShared`
 * (`@agentic-kanban/shared/lib/worktree-claim`), which is the last word on "does a live
 * workspace still claim this directory?". Two things were true before that and are worth
 * stating, because this file was the one `TO CONVERT` site that was NOT simply wrong:
 *
 *  - This file's analysis was STRONGER than the shared guard's on one point, and it is the
 *    unrecoverable direction: a live workspace whose `working_dir` a completed merge already
 *    nulled still holds its BRANCH, and a path-keyed sharer query cannot see it. That
 *    strength was absorbed into the guard as `findLiveBranchHolders` / the optional `branch`
 *    argument rather than left here, and is passed below — so the guard is now a SUPERSET of
 *    `classifyWorktree`'s liveness rules, not a second opinion beside them.
 *  - Two of `classifyWorktree`'s rules are deliberately NOT in the guard. `main_checkout`
 *    is a path-shape question, not a claim (and `removeWorktree`'s own `.worktrees/` guard
 *    covers it). "A row still NAMES this path, whatever its status" exists to avoid racing
 *    `pruneStaleWorktrees`, and absorbing it would deadlock the three guarded sites that
 *    remove exactly a directory a row being closed still names.
 *
 * `classifyWorktree` therefore stays: it is the project-scoped PRE-FILTER (it also decides
 * `unshipped_work`, which the guard knows nothing about, and it is what keeps three git calls
 * off an obviously-claimed entry). It can only ever be more conservative than the guard; the
 * guard is the authority.
 */

/** What a workspace row contributes to the "is this worktree still claimed?" question. */
export interface WorktreeClaimRow {
  workingDir: string | null;
  branch: string | null;
  /** Workspace status; anything other than `closed` is live work. */
  status: string;
}

export type WorktreeVerdict =
  /** The project's own checkout. Never a worktree we may remove. */
  | "main_checkout"
  /** A workspace row still points at this path, or a non-terminal workspace holds its branch. */
  | "claimed"
  /**
   * Unclaimed, but it holds commits or edits that never landed. Reported, never removed —
   * `git worktree remove --force` would destroy them, and a leaked directory is a far cheaper
   * failure than lost work.
   */
  | "unshipped_work"
  /** Unclaimed and carrying nothing: safe to remove. */
  | "orphaned";

/** Windows paths differ in case and separator between `git worktree list` and the DB (#532). */
function samePath(a: string, b: string): boolean {
  return sharedSamePath(a, b);
}

/**
 * The whole decision, as a pure function — the git/DB I/O lives in `reconcileOrphanedWorktrees`
 * below. Split so the rules can be tested against the measured kassenbuch state without a repo.
 */
export function classifyWorktree(args: {
  worktreePath: string;
  mainCheckoutPath: string;
  worktreeBranch: string;
  /** Every workspace row of the project. */
  claims: WorktreeClaimRow[];
  /** Commits on the worktree's branch that are not in the base branch, or uncommitted edits. */
  hasUnshippedWork: boolean;
}): WorktreeVerdict {
  if (samePath(args.worktreePath, args.mainCheckoutPath)) return "main_checkout";

  for (const row of args.claims) {
    // A row that still names the path owns it, whatever its status — that is the case
    // `pruneStaleWorktrees` already handles, and double-removing it would race.
    if (row.workingDir && samePath(row.workingDir, args.worktreePath)) return "claimed";
    // A live workspace on this branch owns the worktree even with `working_dir` nulled (the
    // nulling is what made #361's orphans invisible; it must not make LIVE work removable).
    if (row.status !== "closed" && row.branch && args.worktreeBranch && row.branch === args.worktreeBranch) return "claimed";
  }

  return args.hasUnshippedWork ? "unshipped_work" : "orphaned";
}

export interface OrphanedWorktreeGitPort {
  listWorktrees(repoPath: string): Promise<{ path: string; branch: string }[]>;
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  revParse(repoPath: string, ref: string): Promise<string>;
  countUniqueCommits(repoPath: string, base: string, branch: string): Promise<number>;
  getWorkingTreeDiff(worktreePath: string): Promise<string>;
  /**
   * Does the worktree directory still exist on disk? Optional — defaults to `existsSync`,
   * which is what production wants (a directory that is gone has no working-tree diff to read).
   *
   * It is on the PORT so tests can control it. Without this the fail-closed case reached the
   * real filesystem: its fixture paths are real ones from the #361 investigation, so the test
   * passed only while those directories happened to still exist, and silently changed meaning
   * when a cleanup removed one — the `getWorkingTreeDiff` throw was then never reached and the
   * worktree was classified removable, i.e. the exact behaviour the test exists to forbid.
   */
  pathExists?(worktreePath: string): boolean;
}

export interface OrphanedWorktreeReport {
  removed: string[];
  keptWithUnshippedWork: string[];
  /**
   * Worktrees the shared guard refused to remove — a live workspace shares the path or holds
   * the branch, or the claim read itself failed (#735). Reported rather than swallowed: this
   * reconciler's whole idiom is "say what you did and what you left", and a refusal that only
   * appears in a log line is the shape that lets a stuck sweep look like a clean one.
   */
  keptClaimed: string[];
}

/**
 * Decide whether a worktree holds anything that would be destroyed by `worktree remove --force`.
 *
 * FAIL-CLOSED on every git error: an unreadable worktree is treated as holding work, so a git
 * hiccup leaks a directory instead of deleting commits. `countUniqueCommits` returns 0 on any
 * internal error (which would read as "fully merged"), so the refs are resolved with `revParse`
 * — which throws — first. This mirrors `cleanupSiblingWorktrees`' proven preserve probe.
 */
async function hasUnshippedWork(
  git: OrphanedWorktreeGitPort,
  repoPath: string,
  baseBranch: string,
  worktree: { path: string; branch: string },
): Promise<boolean> {
  if ((git.pathExists ?? existsSync)(worktree.path)) {
    try {
      if ((await git.getWorkingTreeDiff(worktree.path)).trim() !== "") return true;
    } catch {
      return true;
    }
  }
  if (!worktree.branch) return true; // detached HEAD: cannot reason about what it holds.
  try {
    await git.revParse(repoPath, worktree.branch);
  } catch {
    // The branch is GONE while the worktree survives — precisely #361's `…-skele` shape.
    // There is no branch left to hold anything, so nothing is unshipped.
    return false;
  }
  try {
    await git.revParse(repoPath, baseBranch);
    return (await git.countUniqueCommits(repoPath, baseBranch, worktree.branch)) > 0;
  } catch {
    return true;
  }
}

/**
 * Sweep one project's registered worktrees and remove the ones nothing claims.
 *
 * Returns what it did rather than logging only, so a caller (startup, or a post-merge hook) can
 * surface the kept-with-work entries — those are the ones a human has to decide about.
 */
export async function reconcileOrphanedWorktrees(args: {
  repoPath: string;
  baseBranch: string;
  claims: WorktreeClaimRow[];
  git: OrphanedWorktreeGitPort;
  /**
   * Read by the shared removal guard (#735) — the reconciler itself still classifies from
   * `claims`. Required rather than optional: an optional database would mean either a
   * silently unguarded removal (the bug) or a sweep that refuses everything, and neither is
   * something a caller should be able to reach by forgetting an argument.
   */
  database: Database;
}): Promise<OrphanedWorktreeReport> {
  const report: OrphanedWorktreeReport = { removed: [], keptWithUnshippedWork: [], keptClaimed: [] };

  let worktrees: { path: string; branch: string }[];
  try {
    worktrees = await args.git.listWorktrees(args.repoPath);
  } catch (err) {
    console.warn(`[worktree-reconcile] could not list worktrees for ${args.repoPath}: ${errorMessage(err)}`);
    return report;
  }

  for (const worktree of worktrees) {
    // Cheap check first: `classifyWorktree` short-circuits the main checkout and any claimed
    // entry without spending three git calls on the unshipped-work probe.
    const cheap = classifyWorktree({ ...args, worktreePath: worktree.path, mainCheckoutPath: args.repoPath, worktreeBranch: worktree.branch, hasUnshippedWork: false });
    if (cheap === "main_checkout" || cheap === "claimed") continue;

    const verdict = classifyWorktree({
      ...args,
      worktreePath: worktree.path,
      mainCheckoutPath: args.repoPath,
      worktreeBranch: worktree.branch,
      hasUnshippedWork: await hasUnshippedWork(args.git, args.repoPath, args.baseBranch, worktree),
    });
    if (verdict === "unshipped_work") {
      console.warn(`[worktree-reconcile] keeping orphaned worktree ${worktree.path} (${worktree.branch || "detached"}) — it holds work that never landed`);
      report.keptWithUnshippedWork.push(worktree.path);
      continue;
    }

    // #735: the removal itself is the ONE guard's, not this file's. `branch` is passed
    // because it is precisely this reconciler's subject — a worktree whose row has a nulled
    // `working_dir` — and the absorbed branch-keyed check is the only thing that sees a live
    // workspace behind one. See the module header for what the guard does and does not take
    // over from `classifyWorktree`.
    const outcome = await removeWorktreeUnlessShared({
      database: args.database,
      workingDir: worktree.path,
      branch: worktree.branch,
      label: "startup:orphaned-worktree-reconcile",
      removeWorktree: () => args.git.removeWorktree(args.repoPath, worktree.path),
    });
    if (outcome.removed) {
      console.log(`[worktree-reconcile] removed orphaned worktree ${worktree.path} (${worktree.branch || "detached"}) — no workspace claims it and it holds nothing unshipped (#361)`);
      report.removed.push(worktree.path);
    } else if (outcome.reason === "remove-failed") {
      console.warn(`[worktree-reconcile] could not remove orphaned worktree ${worktree.path}: ${errorMessage(outcome.error)}`);
    } else {
      // The guard saw a claim this file's project-scoped `claims` did not (a live sharer, a
      // live branch holder, or a claim read that failed). Reported, not swallowed.
      console.warn(`[worktree-reconcile] ${outcome.message}`);
      report.keptClaimed.push(worktree.path);
    }
  }

  return report;
}
