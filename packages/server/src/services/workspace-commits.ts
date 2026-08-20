import { getCommitCountAhead } from "@agentic-kanban/shared/lib/git-service";
import { listWorkspaceRepos, type RepoDb } from "../repositories/repo.repository.js";

/**
 * The minimum a caller must know about a workspace to ask "did it produce work?".
 * Deliberately structural, so a projection query does not have to select the whole row.
 */
export interface CommittedWorkWorkspace {
  id: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect?: boolean | null;
  baseCommitSha?: string | null;
}

export interface CommittedWorkOptions {
  /**
   * What an UNANSWERABLE git probe means for THIS caller — the single knob, because the
   * downstreams are mirror images and unifying them silently is the bug (#539).
   *
   * `true`  — "no commits" licenses CLOSING a workspace and forcing its issue Done
   *           (exit-workflow), so an unknown must read as "there might be work".
   * `false` — `true` is what makes the caller ACT (recover a blocked workspace, mark a
   *           dead-PID session stopped), so an unknown must not start it acting on no
   *           evidence at all.
   */
  onUnknown: boolean;
  /** Injected for testing — defaults to the shared git-service counter. */
  countAhead?: (cwd: string, base: string, headRef?: string) => Promise<number | null>;
}

/**
 * True when the workspace has committed work against its base — in the LEADING repo or in
 * ANY sibling repo.
 *
 * The sibling half is the point (#69): a sibling-only ticket commits entirely outside the
 * leading worktree, so every leading-repo-only reader saw "no committed changes" and either
 * force-closed the issue with the sibling commit stranded (exit-workflow, before #69) or
 * silently declined to recover the workspace at all (completion-state-reconciler,
 * stranded-review-reconciler — the readers this ticket adopts).
 *
 * Best-effort per repo: a git error on one sibling reads as "no change" for that sibling,
 * never as an answer for the whole workspace.
 */
export async function workspaceHasCommittedWork(
  ws: CommittedWorkWorkspace,
  defaultBranch: string | null,
  database: RepoDb,
  opts: CommittedWorkOptions,
): Promise<boolean> {
  const countAhead = opts.countAhead ?? getCommitCountAhead;
  if (!ws.workingDir) return false;

  // A direct workspace has no branch of its own — it commits onto the checked-out branch,
  // so the base is the sha it started from. It also has no sibling worktrees.
  if (ws.isDirect) {
    const ahead = await countAhead(ws.workingDir, ws.baseCommitSha || "HEAD~1").catch(() => null);
    return ahead === null ? opts.onUnknown : ahead > 0;
  }

  const base = ws.baseBranch || defaultBranch;
  if (!base) return false;

  // #365: count commits rather than diffing the working tree against the base TIP — the
  // latter reported "has changes" for a branch that was merely BEHIND its base.
  const leading = await countAhead(ws.workingDir, base).catch(() => null);
  if (leading !== null && leading > 0) return true;

  if (await hasSiblingCommittedWork(ws.id, defaultBranch, database, countAhead)) return true;
  return leading === null ? opts.onUnknown : false;
}

/**
 * Per-sibling commits-ahead probe. Uses the sibling's own worktree when it still exists and
 * falls back to counting `branch` against base from the sibling's main checkout when the
 * worktree is already gone — both are the same `rev-list --count` question, just from a
 * different cwd.
 */
async function hasSiblingCommittedWork(
  workspaceId: string,
  defaultBranch: string | null,
  database: RepoDb,
  countAhead: (cwd: string, base: string, headRef?: string) => Promise<number | null>,
): Promise<boolean> {
  let repos;
  try {
    repos = await listWorkspaceRepos(workspaceId, database);
  } catch { return false; }
  for (const repo of repos) {
    const base = repo.baseBranch || defaultBranch;
    if (!base) continue;
    try {
      if (repo.worktreePath) {
        if ((await countAhead(repo.worktreePath, base) ?? 0) > 0) return true;
      } else if (repo.branch) {
        if ((await countAhead(repo.path, base, repo.branch) ?? 0) > 0) return true;
      }
    } catch { /* non-fatal: treat this sibling as no-change */ }
  }
  return false;
}
