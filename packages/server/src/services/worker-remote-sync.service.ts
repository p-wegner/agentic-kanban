// Board-side sync of remote worker results (epic #184, phase 2 #188).
//
// A remote worker pushes its work to `refs/kanban/incoming/<branch>` in the
// board's own repo (the git-http service refuses anything else). This module
// turns that staging ref into the REAL branch, after which every existing
// board mechanism — diff, review, conflict detection, merge — works unchanged
// against a normal local branch, exactly as if a host builder had produced it.
//
// Fast-forward only. If the branch has moved on independently of the incoming
// ref, that is a genuine divergence the board must surface rather than paper
// over with a force-update that would silently discard commits.

import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { KANBAN_INCOMING_REF_PREFIX } from "./git-http.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function incomingRefFor(branch: string): string {
  return `${KANBAN_INCOMING_REF_PREFIX}${branch}`;
}

export type SyncOutcome =
  | { ok: true; status: "updated" | "unchanged" | "created"; sha: string }
  | { ok: false; status: "missing" | "diverged" | "error"; error: string };

/**
 * Advance `refs/heads/<branch>` to whatever the worker pushed to the incoming
 * ref. Uses `update-ref` rather than a checkout so a branch that IS checked out
 * in a board worktree is never touched behind git's back — a checked-out branch
 * is instead reported as diverged/held for the caller to handle.
 */
export async function syncIncomingBranch(repoPath: string, branch: string): Promise<SyncOutcome> {
  const incoming = incomingRefFor(branch);
  const target = `refs/heads/${branch}`;

  const incomingSha = await gitExec(["rev-parse", "--verify", `${incoming}^{commit}`], { cwd: repoPath });
  if (incomingSha.code !== 0) {
    return { ok: false, status: "missing", error: `no incoming ref ${incoming}` };
  }
  const sha = incomingSha.stdout.trim();

  const currentSha = await gitExec(["rev-parse", "--verify", `${target}^{commit}`], { cwd: repoPath });
  if (currentSha.code !== 0) {
    try {
      await gitExecOrThrow(["update-ref", target, sha], { cwd: repoPath });
      return { ok: true, status: "created", sha };
    } catch (err) {
      return { ok: false, status: "error", error: errorMessage(err) };
    }
  }
  const current = currentSha.stdout.trim();
  if (current === sha) return { ok: true, status: "unchanged", sha };

  // Fast-forward check: the current tip must be an ancestor of the incoming one.
  const ancestor = await gitExec(["merge-base", "--is-ancestor", current, sha], { cwd: repoPath });
  if (ancestor.code !== 0) {
    return {
      ok: false,
      status: "diverged",
      error:
        `local ${branch} (${current.slice(0, 8)}) is not an ancestor of the worker's ` +
        `push (${sha.slice(0, 8)}); refusing to fast-forward`,
    };
  }

  // A branch checked out in a worktree must not be moved by update-ref — git
  // would leave that worktree's index/HEAD inconsistent with the new tip.
  const checkedOut = await isBranchCheckedOut(repoPath, branch);
  if (checkedOut) {
    return {
      ok: false,
      status: "diverged",
      error: `${branch} is checked out in a worktree; sync the worktree instead of moving the ref`,
    };
  }

  try {
    await gitExecOrThrow(["update-ref", target, sha, current], { cwd: repoPath });
    console.log(`[worker-sync] fast-forwarded ${branch} to ${sha.slice(0, 8)} from ${incoming}`);
    return { ok: true, status: "updated", sha };
  } catch (err) {
    return { ok: false, status: "error", error: errorMessage(err) };
  }
}

/** True when `branch` is checked out in the main checkout or any linked worktree. */
export async function isBranchCheckedOut(repoPath: string, branch: string): Promise<boolean> {
  const result = await gitExec(["worktree", "list", "--porcelain"], { cwd: repoPath });
  if (result.code !== 0) return false;
  return result.stdout.split(/\r?\n/).some((line) => line.trim() === `branch refs/heads/${branch}`);
}

/**
 * Pull the worker's work into a board worktree that has the branch checked out:
 * fast-forward the working tree itself via `merge --ff-only` from the incoming
 * ref. Used when `syncIncomingBranch` reports the branch is held by a worktree.
 */
export async function syncIncomingIntoWorktree(worktreePath: string, branch: string): Promise<SyncOutcome> {
  const incoming = incomingRefFor(branch);
  const shaResult = await gitExec(["rev-parse", "--verify", `${incoming}^{commit}`], { cwd: worktreePath });
  if (shaResult.code !== 0) {
    return { ok: false, status: "missing", error: `no incoming ref ${incoming}` };
  }
  const sha = shaResult.stdout.trim();
  const head = await gitExec(["rev-parse", "HEAD"], { cwd: worktreePath });
  if (head.code === 0 && head.stdout.trim() === sha) {
    return { ok: true, status: "unchanged", sha };
  }
  const merge = await gitExec(["merge", "--ff-only", incoming], { cwd: worktreePath });
  if (merge.code !== 0) {
    return {
      ok: false,
      status: "diverged",
      error: `fast-forward of ${branch} from ${incoming} failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
    };
  }
  console.log(`[worker-sync] worktree ${branch} fast-forwarded to ${sha.slice(0, 8)}`);
  return { ok: true, status: "updated", sha };
}

/** Drop the staging ref once its content has landed on the real branch. */
export async function clearIncomingRef(repoPath: string, branch: string): Promise<void> {
  await gitExec(["update-ref", "-d", incomingRefFor(branch)], { cwd: repoPath });
}
