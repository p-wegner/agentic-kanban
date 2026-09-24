import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import type { MergeTrainState } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import * as gitService from "./git.service.js";

/**
 * #1235 — the ONE place that knows how a `kanban/train/*` worktree relates to a `merge_trains`
 * row, and how such a worktree is torn down.
 *
 * MEASURED 2026-09-24 on this board's own checkout: ten `kanban/train/*` worktrees dated
 * 2026-09-14..21, each with a full `node_modules`, kept on every boot by the orphaned-worktree
 * reconciler with `keeping orphaned worktree … it holds N commit(s) the base branch does not
 * have`. The commits it was protecting are the train's own integration merges — content that
 * either LANDED (master carries it under a different merge sha) or was abandoned with the train.
 * Nothing about a train worktree is recoverable work, so "unmerged commits" is the wrong
 * question for it; the right one is the state of the train row it belongs to.
 *
 * Two things had kept #1208's stale-train sweep from catching them, both fixed here:
 *  - a BISECT attempt's branch is the row's label plus trailing letters (`…-03babb` for row
 *    `train/2026-09-19-03`), and the sweep keyed its lookup on the worktree's raw leaf, so it
 *    only ever matched a top-level attempt — every bisect worktree read as "no row".
 *  - even when the worktree WAS removed, the branch stayed: `git branch -D` had already failed
 *    inside `runMergeTrain`'s `finally` with "checked out at <worktree>", and nothing retried it
 *    after the worktree went. {@link removeTrainWorktree} deletes the branch AFTER the worktree.
 *
 * Every removal goes through `removeWorktreeUnlessShared` (the #713 guard) with
 * `treatAnyRowAsClaim`, so a workspace row that names the path — impossible for a train leaf
 * today, but that is exactly what a guard is for — still refuses. The directory itself is
 * removed by the shared `removeWorktree`, which breaks junctions before deleting (#518/#780),
 * the same reparse-point rule `scripts/safe-rmdir.mjs` enforces by hand.
 */

export const TRAIN_BRANCH_PREFIX = "kanban/train/";

/** The row states after which a train's worktree holds nothing anyone will come back for. */
export const MERGE_TRAIN_TERMINAL_STATES: readonly MergeTrainState[] = ["landed", "red", "abandoned"];

export function isTerminalMergeTrainState(state: string): boolean {
  return (MERGE_TRAIN_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * `git worktree list --porcelain` (and so `listWorktrees`) reports a branch as
 * `refs/heads/<name>`; the DB and `git branch -D` speak the short name. Everything here
 * compares and deletes on the short form.
 */
export function shortBranchName(branch: string | null | undefined): string {
  if (!branch) return "";
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

export function isTrainBranch(branch: string | null | undefined): boolean {
  return shortBranchName(branch).startsWith(TRAIN_BRANCH_PREFIX);
}

/** `[refs/heads/]kanban/train/<attempt label>` → `<attempt label>`, or null for any other branch. */
export function trainAttemptLabelFromBranch(branch: string | null | undefined): string | null {
  return isTrainBranch(branch) ? shortBranchName(branch).slice(TRAIN_BRANCH_PREFIX.length) : null;
}

/**
 * The row an ATTEMPT label belongs to. An attempt is the row's own label (the full train) or the
 * row's label plus one or more trailing lowercase letters (a bisect half: `a`/`b` per split,
 * nested). Matched by prefix rather than by `parentTrainLabel` (which strips ALL trailing
 * letters) because the pre-#1190 `q<base36 timestamp>` labels END in letters themselves —
 * stripping them mangles the row's own label and nothing matches. The LONGEST matching row
 * label wins, so a row `q1a` does not claim the worktree of a row `q1ab`.
 */
export function findTrainRowForAttemptLabel<R extends { label: string }>(
  attemptLabel: string,
  rows: readonly R[],
): R | undefined {
  let best: R | undefined;
  for (const row of rows) {
    if (attemptLabel === row.label) return row;
    if (!attemptLabel.startsWith(row.label)) continue;
    if (!/^[a-z]+$/.test(attemptLabel.slice(row.label.length))) continue;
    if (!best || row.label.length > best.label.length) best = row;
  }
  return best;
}

export type TrainWorktreeAction =
  /** The row is terminal (landed/red/abandoned): the worktree and its branch may go. */
  | "remove"
  /** The row is assembling/gating/landing: a job may be using the worktree right now. */
  | "keep_in_flight"
  /** No row of any state carries this label: attributable to nothing, so kept and reported. */
  | "keep_unknown";

export function decideTrainWorktreeAction(row: { state: string } | undefined): TrainWorktreeAction {
  if (!row) return "keep_unknown";
  return isTerminalMergeTrainState(row.state) ? "remove" : "keep_in_flight";
}

/**
 * "No row at all" is logged ONCE per process per path, not on every sweep — the periodic
 * train sweep runs every ten minutes and the boot reconciler once, and a kept-forever
 * directory that re-announces itself every cycle is exactly the notice people learn to skip.
 */
const unknownTrainWorktreesLogged = new Set<string>();

/** True the first time this path is seen in this process. */
export function noteUnknownTrainWorktreeOnce(worktreePath: string): boolean {
  const key = worktreePath.replace(/\\/g, "/").toLowerCase();
  if (unknownTrainWorktreesLogged.has(key)) return false;
  unknownTrainWorktreesLogged.add(key);
  return true;
}

/** Test seam — the set is module state. */
export function resetUnknownTrainWorktreeLog(): void {
  unknownTrainWorktreesLogged.clear();
}

export interface RemoveTrainWorktreeArgs {
  database: Database;
  repoPath: string;
  worktreePath: string;
  /** The worktree's branch (`kanban/train/<attempt>`), deleted after the directory. Empty = detached. */
  branch: string;
  /** Guard label, for the guard's own log line. */
  label: string;
  /** The git operations; defaults to the real shared git service. A reconciler passes its port. */
  git?: TrainWorktreeGitPort;
}

/** The slice of a git port these helpers use — the orphaned-worktree reconciler's port satisfies it. */
export interface TrainWorktreeGitPort {
  listWorktrees?(repoPath: string): Promise<{ path: string; branch: string }[]>;
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  /** Optional: a port without it removes the directory and leaves the ref (reported as `branchDeleted: false`). */
  deleteBranch?(repoPath: string, branch: string, options?: { force?: boolean }): Promise<void>;
}

export type RemoveTrainWorktreeOutcome =
  | { removed: true; branchDeleted: boolean; branchError?: string }
  | { removed: false; reason: string; message: string };

/**
 * Remove one train worktree through the guard, then delete its branch. The branch delete is
 * best-effort: the worktree is the thing that holds the disk, and a lingering ref is what
 * `deleteTrainRef` already tolerates. It comes AFTER the worktree because git refuses to
 * delete a branch that is checked out — which is why the leftover branches existed at all.
 */
export async function removeTrainWorktree(args: RemoveTrainWorktreeArgs): Promise<RemoveTrainWorktreeOutcome> {
  const git: TrainWorktreeGitPort = args.git ?? gitService;
  const branch = shortBranchName(args.branch);
  const outcome = await removeWorktreeUnlessShared({
    database: args.database,
    workingDir: args.worktreePath,
    branch: branch || undefined,
    treatAnyRowAsClaim: true,
    label: args.label,
    removeWorktree: () => git.removeWorktree(args.repoPath, args.worktreePath),
  }).catch((err) => ({ removed: false as const, reason: "remove-failed" as const, message: errorMessage(err), error: err }));
  if (!outcome.removed) return { removed: false, reason: outcome.reason, message: outcome.message };
  if (!branch || !git.deleteBranch) return { removed: true, branchDeleted: false };
  try {
    await git.deleteBranch(args.repoPath, branch, { force: true });
    return { removed: true, branchDeleted: true };
  } catch (err) {
    return { removed: true, branchDeleted: false, branchError: errorMessage(err) };
  }
}

export interface CleanupTrainWorktreesResult {
  removed: string[];
  failed: Array<{ path: string; message: string }>;
}

/**
 * The train service's OWN teardown at a terminal transition (#1235 part 2): every worktree on a
 * `kanban/train/<label>[bisect letters]` branch of this train goes, with its branch. The gate's
 * per-attempt `finally` already removes its worktree on a normal exit, so on the happy path
 * this finds nothing and costs one `git worktree list`; it earns its place when that `finally`
 * was skipped (a killed gate, a guard refusal that has since cleared) or removed the directory
 * but left the branch. Never throws — a transition must not fail on its own housekeeping — and
 * asks no question about the row's state: the caller IS the transition.
 */
export async function cleanupTrainWorktreesForLabel(args: {
  database: Database;
  repoPath: string;
  label: string;
  log?: (message: string) => void;
  git?: TrainWorktreeGitPort;
}): Promise<CleanupTrainWorktreesResult> {
  const log = args.log ?? ((message: string) => console.log(`[merge-train] ${message}`));
  const result: CleanupTrainWorktreesResult = { removed: [], failed: [] };
  let worktrees: { path: string; branch: string }[];
  try {
    worktrees = await (args.git?.listWorktrees ?? gitService.listWorktrees)(args.repoPath);
  } catch (err) {
    log(`${args.label}: could not list worktrees to clean up after the train (non-fatal): ${errorMessage(err)}`);
    return result;
  }
  for (const wt of worktrees) {
    const attempt = trainAttemptLabelFromBranch(wt.branch);
    if (attempt === null) continue;
    if (!findTrainRowForAttemptLabel(attempt, [{ label: args.label }])) continue;
    const outcome = await removeTrainWorktree({
      database: args.database,
      repoPath: args.repoPath,
      worktreePath: wt.path,
      branch: wt.branch,
      label: "merge-train-terminal-cleanup",
      git: args.git,
    });
    if (outcome.removed) {
      result.removed.push(wt.path);
      log(`${args.label}: removed staging worktree ${wt.path} (${wt.branch})${outcome.branchDeleted ? " and its branch" : outcome.branchError ? ` — branch left: ${outcome.branchError}` : ""}`);
    } else {
      result.failed.push({ path: wt.path, message: outcome.message });
      log(`${args.label}: could not remove staging worktree ${wt.path} (non-fatal, the reconciler will retry): ${outcome.message}`);
    }
  }
  return result;
}

/**
 * Bytes under a directory, for the CLI's leftover report. BOUNDED: after `maxEntries` directory
 * entries it stops and says so (`capped: true`), so a `node_modules` of a hundred thousand files
 * costs a bounded walk, not a `du`. Symlinks and junctions are never followed — a train
 * worktree's `node_modules` may be a junction into the main checkout (#518), and counting the
 * shared store as the worktree's own would be both slow and wrong.
 */
export async function estimateDirectorySize(
  dir: string,
  maxEntries = 30_000,
): Promise<{ bytes: number; entries: number; capped: boolean }> {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++entries > maxEntries) return { bytes, entries, capped: true };
      if (d.isSymbolicLink()) continue;
      const full = join(current, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        try {
          bytes += (await stat(full)).size;
        } catch {
          // unreadable entry: skip
        }
      }
    }
  }
  return { bytes, entries, capped: false };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
