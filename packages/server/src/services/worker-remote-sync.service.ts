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
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

export function incomingRefFor(branch: string): string {
  return `${KANBAN_INCOMING_REF_PREFIX}${branch}`;
}

export type SyncOutcome =
  | {
      ok: true;
      status: "updated" | "unchanged" | "created";
      sha: string;
      via?: "ref" | "worktree";
      /** The worktree the landing went through, when it went through one. */
      worktreePath?: string;
    }
  | {
      ok: false;
      status: "missing" | "diverged" | "held-by-worktree" | "error";
      error: string;
      via?: "ref" | "worktree";
      /** The worktree the landing was attempted in, when it went through one. */
      worktreePath?: string;
    };

/**
 * Advance `refs/heads/<branch>` to whatever the worker pushed to the incoming
 * ref, WITHOUT touching any working tree — `update-ref` only.
 *
 * This is the ref-only arm, not the landing operation. It cannot move a branch that
 * a worktree has checked out (git would leave that worktree's index and HEAD
 * inconsistent with the new tip), and reports `held-by-worktree` when one does.
 * Callers want `syncIncomingBranch` below, which handles that case; this is exported
 * for tests and for anything that specifically needs the no-working-tree guarantee.
 */
export async function fastForwardBranchRef(repoPath: string, branch: string): Promise<SyncOutcome> {
  const incoming = incomingRefFor(branch);
  const target = `refs/heads/${branch}`;

  const incomingSha = await gitExec(["rev-parse", "--verify", `${incoming}^{commit}`], { cwd: repoPath });
  if (!execSucceeded(incomingSha)) {
    return { ok: false, status: "missing", error: `no incoming ref ${incoming}` };
  }
  const sha = incomingSha.stdout.trim();

  const currentSha = await gitExec(["rev-parse", "--verify", `${target}^{commit}`], { cwd: repoPath });
  if (!execSucceeded(currentSha)) {
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
  if (!execSucceeded(ancestor)) {
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
  //
  // This is NOT a divergence — the fast-forward check above already passed — so it
  // gets its own status (#743). It used to report `diverged`, which made the ONE
  // outcome that a real workspace ALWAYS produces indistinguishable from the one
  // outcome that must never be resolved automatically, and callers therefore gave up
  // on both. `syncIncomingBranch` below routes this status into the worktree.
  const checkedOut = await isBranchCheckedOut(repoPath, branch);
  if (checkedOut) {
    return {
      ok: false,
      status: "held-by-worktree",
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
  return (await findBranchWorktree(repoPath, branch)) !== null;
}

/**
 * The path of the worktree (main checkout included) that has `branch` checked out,
 * or null when no worktree holds it.
 *
 * Git itself is the authority here, not the DB: `workspaces.workingDir` can be stale
 * or point at a worktree that has since been moved or detached, whereas
 * `worktree list --porcelain` reports exactly the attachment that makes `update-ref`
 * unsafe. A `branch` line is only emitted for an ATTACHED HEAD, so a hit here also
 * guarantees the worktree is on the branch — which is what makes the in-tree
 * fast-forward below safe.
 */
export async function findBranchWorktree(repoPath: string, branch: string): Promise<string | null> {
  const result = await gitExec(["worktree", "list", "--porcelain"], { cwd: repoPath });
  if (!execSucceeded(result)) return null;
  let current: string | null = null;
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length).trim();
      continue;
    }
    if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/**
 * Pull the worker's work into a board worktree that has the branch checked out:
 * fast-forward the working tree itself via `merge --ff-only` from the incoming
 * ref. Used when `syncIncomingBranch` reports the branch is held by a worktree.
 */
export async function syncIncomingIntoWorktree(worktreePath: string, branch: string): Promise<SyncOutcome> {
  const incoming = incomingRefFor(branch);
  const shaResult = await gitExec(["rev-parse", "--verify", `${incoming}^{commit}`], { cwd: worktreePath });
  if (!execSucceeded(shaResult)) {
    return { ok: false, status: "missing", error: `no incoming ref ${incoming}` };
  }
  const sha = shaResult.stdout.trim();
  // Defensive (#743): only ever fast-forward a worktree that is ATTACHED to the
  // branch. On a detached HEAD `merge --ff-only` would move HEAD and leave
  // `refs/heads/<branch>` behind, so review/merge — which read the branch — would
  // still see nothing, and "landed" would be a lie. Reattaching by forcing the
  // branch onto HEAD is NOT an option: HEAD may be behind the branch, and that
  // would discard commits.
  const attached = await gitExec(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktreePath });
  if (!execSucceeded(attached) || attached.stdout.trim() !== `refs/heads/${branch}`) {
    return {
      ok: false,
      status: "error",
      error:
        `worktree ${worktreePath} is not attached to ${branch} ` +
        `(HEAD is ${attached.stdout.trim() || "detached"}); refusing to fast-forward it`,
    };
  }
  const head = await gitExec(["rev-parse", "HEAD"], { cwd: worktreePath });
  if (execSucceeded(head) && head.stdout.trim() === sha) {
    return { ok: true, status: "unchanged", sha };
  }
  const merge = await gitExec(["merge", "--ff-only", incoming], { cwd: worktreePath });
  if (!execSucceeded(merge)) {
    return {
      ok: false,
      status: "diverged",
      error: `fast-forward of ${branch} from ${incoming} failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
    };
  }
  console.log(`[worker-sync] worktree ${branch} fast-forwarded to ${sha.slice(0, 8)}`);
  return { ok: true, status: "updated", sha };
}

/**
 * Land a worker's push on the real branch — the WHOLE operation, through whichever
 * of the two mechanisms the branch's state requires. This is what every caller uses.
 *
 * #743: this used to be the ref-only arm alone (now `fastForwardBranchRef`), and so it
 * could never land the result of a real workspace. `POST /api/workspaces` creates the
 * board-side worktree — and therefore checks the branch out — before placement is even
 * resolved, so the ref arm was refused for EVERY genuine remote build: the exit path
 * downgraded the session to "Worker result could not be landed", the branch stayed at
 * base, and review/merge saw nothing. `syncIncomingIntoWorktree` was written as the
 * remedy and had zero non-test callers; the fix is to make it the fall-through of the
 * one function the callers already call, rather than a second function they must know
 * to reach for.
 *
 * Still FAST-FORWARD ONLY, in both arms: the ref arm uses `update-ref` with the
 * expected old value, the worktree arm uses `merge --ff-only`. Neither can discard a
 * commit, and a genuine divergence is still returned held for a human (decision 012).
 * Never `git reset` in a worktree — that corrupts `.git` for linked worktrees.
 */
export async function syncIncomingBranch(
  repoPath: string,
  branch: string,
  opts?: { worktreePath?: string },
): Promise<SyncOutcome> {
  const direct = await fastForwardBranchRef(repoPath, branch);
  if (direct.ok || direct.status !== "held-by-worktree") return { ...direct, via: "ref" };

  // Git is asked which worktree holds the branch; the caller's hint is only a fallback.
  const worktreePath = (await findBranchWorktree(repoPath, branch)) ?? opts?.worktreePath;
  if (!worktreePath) {
    return {
      ...direct,
      error: `${direct.error} (no worktree path could be resolved for ${branch})`,
    };
  }
  const inTree = await syncIncomingIntoWorktree(worktreePath, branch);
  return { ...inTree, via: "worktree", worktreePath };
}

/** Drop the staging ref once its content has landed on the real branch. */
export async function clearIncomingRef(repoPath: string, branch: string): Promise<void> {
  await gitExec(["update-ref", "-d", incomingRefFor(branch)], { cwd: repoPath });
}
