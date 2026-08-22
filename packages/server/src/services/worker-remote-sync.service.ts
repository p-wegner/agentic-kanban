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

// -- Mid-session, BOARD-INITIATED repo operations on a live remote session -----------
//
// Everything above lands a result the worker pushed at exit. The two functions below are
// the other direction and the other TIME: they act while the agent is still running.
//
//  - #783: before a follow-up `/turn` reaches a remote agent's stdin, the worker's
//    checkout is fast-forwarded to the board's branch tip. Without it the second turn
//    runs against the tree the session cloned, and every board feature built on
//    follow-up turns (nudges, fix-and-merge, monitor unstick, the review loop) is
//    silently host-only.
//  - #784: before a diff is READ, the worker is asked to push its current HEAD, and the
//    board lands it through `syncIncomingBranch` -- the one landing path.
//
// Both take their collaborators as PARAMETERS rather than importing them. That is not
// taste: the remote agent service imports this module (to land at exit) and the live
// liveness probe imports the fleet facade which constructs that service, so importing
// either here -- statically or as a type, which dependency-cruiser also counts -- closes
// a cycle. `remote-session-liveness.ts` documents the same constraint for the same reason.

/** The subset of the remote agent service these operations need. Structural on purpose. */
export interface RemoteRepoOpPort {
  remoteSessionInfo(sessionId: string): { workerId: string; repo?: { repoPath: string; branch: string } } | undefined;
  requestRepoOp(
    sessionId: string,
    op: "sync" | "push",
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; status: string; sha?: string; error?: string }>;
}

/** A remote session as the two operations below need to see it. */
export interface RemoteSessionRef {
  id: string;
  workerId: string | null;
  startedAt?: string | null;
}

/** The liveness rule, injected (see the note above on why it is not imported). */
export type ProbeLiveness = (row: { workerId: string; startedAt?: string | null }) => Promise<{
  liveness: "alive" | "dead" | "unknown";
  reason: string;
}>;

export type RemoteTurnGate =
  | {
      ok: true;
      /**
       * `not-remote` -- a host session, or a filesystem-sharing worker that works in the
       * board's own worktree: nothing to sync, and saying so is not the same as syncing.
       */
      status: "not-remote" | "synced" | "unchanged";
      reason: string;
      sha?: string;
    }
  | {
      ok: false;
      /** CONFLICT (409) needs a human; UNPROCESSABLE (422) means the sync could not be done. */
      kind: "conflict" | "unprocessable";
      status: string;
      reason: string;
    };

/**
 * Decide whether a follow-up turn may be delivered to this workspace's running session,
 * syncing the worker's checkout first when it is remote (#783).
 *
 * The refusal is the point. A turn written into a stale checkout produces a diff that can
 * silently revert the board's own commits, and the board cannot tell that apart from the
 * agent's intent -- whereas a refused turn is a sentence an operator can act on. So:
 *
 *  - `diverged` / `dirty-held` from the worker -> CONFLICT. Both mean a fast-forward would
 *    have had to destroy something, and neither is ever resolved automatically here.
 *  - liveness `unknown` -> UNPROCESSABLE, not "the checkout is probably fine". `unknown` is
 *    absence of information (see `remote-session-liveness.ts`), and the board holds on it
 *    everywhere else.
 *  - no answer within the bound -> UNPROCESSABLE.
 */
export async function gateRemoteTurn(params: {
  session: RemoteSessionRef | null;
  ops: RemoteRepoOpPort;
  probeLiveness: ProbeLiveness;
  timeoutMs?: number;
}): Promise<RemoteTurnGate> {
  const { session, ops, probeLiveness, timeoutMs } = params;
  if (!session?.workerId) {
    return { ok: true, status: "not-remote", reason: "session does not run on a fleet worker" };
  }
  const info = ops.remoteSessionInfo(session.id);
  if (!info) {
    return {
      ok: false,
      kind: "unprocessable",
      status: "not-tracked",
      reason:
        `session ${session.id} runs on fleet worker ${session.workerId}, but this board process ` +
        `does not track it (it was started before a restart), so its checkout cannot be brought ` +
        `up to date - relaunch the workspace instead of continuing it`,
    };
  }
  if (!info.repo) {
    return {
      ok: true,
      status: "not-remote",
      reason: `worker ${session.workerId} shares this filesystem, so it already works in the board's worktree`,
    };
  }
  const verdict = await probeLiveness({ workerId: session.workerId, startedAt: session.startedAt ?? null });
  if (verdict.liveness !== "alive") {
    return {
      ok: false,
      kind: "unprocessable",
      status: verdict.liveness,
      reason:
        `the worker running this session is ${verdict.liveness} (${verdict.reason}), so its checkout ` +
        `cannot be synced - a turn delivered into a stale checkout is worse than a refused one`,
    };
  }
  const outcome = await ops.requestRepoOp(session.id, "sync", timeoutMs ? { timeoutMs } : undefined);
  if (outcome.ok) {
    return {
      ok: true,
      status: outcome.status === "unchanged" ? "unchanged" : "synced",
      reason: `worker checkout ${outcome.status}${outcome.sha ? ` at ${outcome.sha.slice(0, 8)}` : ""}`,
      ...(outcome.sha ? { sha: outcome.sha } : {}),
    };
  }
  const conflict = outcome.status === "diverged" || outcome.status === "dirty-held";
  return {
    ok: false,
    kind: conflict ? "conflict" : "unprocessable",
    status: outcome.status,
    reason: outcome.error ?? `the worker could not sync its checkout (${outcome.status})`,
  };
}

/** What a mid-session diff read learned about the remote session's work (#784). */
export interface MidSessionLanding {
  /** True when new commits were fast-forwarded onto the board's branch by THIS call. */
  landed: boolean;
  status: string;
  sha?: string;
  /** How the landing went, or why it did not happen -- always populated. */
  reason: string;
  /** ms between asking the worker and having it landed, i.e. how fresh the diff is. */
  ageMs?: number;
  /** The worker's liveness at the time of the read; `unknown` is NOT "no new work". */
  liveness?: "alive" | "dead" | "unknown";
}

/**
 * Bring a RUNNING remote session's work onto the board's branch so a diff can see it
 * (#784), then report how fresh that is.
 *
 * ON DEMAND, NOT ON A TIMER -- the decision this ticket asked for, and the reason is the
 * board's own worktree. The session's branch is checked out there, so a landing moves that
 * working tree: files change under anything else reading it (the diff service's own git
 * spawns, a verify script, an operator with an editor open). A timer would do that at
 * moments nothing asked for, to a workspace nobody is looking at, repeatedly. Landing when
 * a diff is REQUESTED keeps the movement inside one read that already expects to see new
 * content, makes the cost proportional to how often anyone actually looks, and -- since
 * the request is what triggers the worker's push -- means the answer is as fresh as it can
 * be rather than as fresh as the last tick. The board pays nothing for a remote session
 * nobody inspects.
 *
 * Fast-forward only, through `syncIncomingBranch` and no private second path. A divergence
 * is HELD and reported, never forced -- mid-session is exactly when a force would destroy
 * work that only exists on one side.
 */
export async function landRemoteMidSessionWork(params: {
  session: RemoteSessionRef | null;
  ops: RemoteRepoOpPort;
  probeLiveness: ProbeLiveness;
  timeoutMs?: number;
  nowMs?: number;
}): Promise<MidSessionLanding | null> {
  const { session, ops, probeLiveness, timeoutMs } = params;
  if (!session?.workerId) return null;
  const info = ops.remoteSessionInfo(session.id);
  // A filesystem-sharing worker writes into the board's worktree, so the diff is already
  // live and there is nothing to land.
  if (!info?.repo) return null;
  const startedMs = params.nowMs ?? Date.now();
  const verdict = await probeLiveness({ workerId: session.workerId, startedAt: session.startedAt ?? null });
  if (verdict.liveness !== "alive") {
    // #784 item 4: `unknown` must not read as "no new work". The diff still answers -- with
    // whatever already landed -- but it says that it may be behind, and why.
    return {
      landed: false,
      status: verdict.liveness,
      liveness: verdict.liveness,
      reason:
        `the worker running this session is ${verdict.liveness} (${verdict.reason}), so this diff may ` +
        `be missing work that exists only in the worker's checkout`,
    };
  }
  const pushed = await ops.requestRepoOp(session.id, "push", timeoutMs ? { timeoutMs } : undefined);
  if (!pushed.ok) {
    return {
      landed: false,
      status: pushed.status,
      liveness: "alive",
      reason:
        `the worker could not push its current work (${pushed.status}: ${pushed.error ?? "no detail"}), ` +
        `so this diff shows only what had already landed`,
    };
  }
  const repo = info.repo;
  const outcome = await syncIncomingBranch(repo.repoPath, repo.branch);
  const ageMs = Math.max(0, Date.now() - startedMs);
  if (!outcome.ok) {
    return {
      landed: false,
      status: outcome.status,
      liveness: "alive",
      ageMs,
      reason:
        `the worker's mid-session push could not be landed on ${repo.branch} (${outcome.status}: ` +
        `${outcome.error}); it is HELD in ${incomingRefFor(repo.branch)} and nothing was forced`,
    };
  }
  // Drop the staging ref once it has landed, so it never means anything but "pushed and
  // not yet landed". Leaving a stale mid-session ref behind would let the EXIT path land
  // it and report success for work older than the run (`landAndFinish` reads this ref).
  await clearIncomingRef(repo.repoPath, repo.branch).catch(() => {});
  return {
    landed: outcome.status === "updated" || outcome.status === "created",
    status: outcome.status,
    liveness: "alive",
    ageMs,
    ...(outcome.sha ? { sha: outcome.sha } : {}),
    reason:
      `the worker's current HEAD was pushed and fast-forwarded onto ${repo.branch} ` +
      `(${outcome.status}${outcome.via ? ` via ${outcome.via}` : ""}); only COMMITTED work travels - ` +
      `the agent's uncommitted edits stay in its own checkout`,
  };
}
