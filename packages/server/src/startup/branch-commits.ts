import { gitExec } from "@agentic-kanban/shared/lib/git-exec";

/**
 * How many commits a branch has that its base lacks — the ONLY correct predicate for
 * "did this workspace produce work?".
 *
 * #365: every caller used to ask `git diff --quiet <base>` instead. With a single ref that
 * is a *working-tree* diff against the base BRANCH TIP, so it exits non-zero — "has
 * changes" — whenever the base has merely moved ahead of the worktree. A workspace with
 * ZERO commits of its own that is simply BEHIND master therefore reported "has commits",
 * got parked at ready_for_merge, and stalled its pipeline unit (#363). Measured on the
 * `ak-6` worktree: 0 commits ahead, 8 behind master, `git diff --quiet master` exit 1.
 *
 * `rev-list --count <base>..HEAD` asks the actual question and is immune to the base moving.
 *
 * Returns `null` when git could not answer (spawn failure, unknown ref, not a worktree).
 * Callers decide what an unknown means; they must NOT read it as zero, since the
 * pre-#365 error behaviour was to assume work existed rather than risk discarding it.
 */
export async function commitsAhead(cwd: string, baseRef: string, headRef = "HEAD"): Promise<number | null> {
  const res = await gitExec(["rev-list", "--count", `${baseRef}..${headRef}`], { cwd });
  if (res.code !== 0) return null;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * True when `headRef` has at least one commit its base lacks. An unknown answer reads as
 * `true` (see `commitsAhead`): the downstream of "no commits" can close a workspace and
 * force its issue to Done, so a transient git failure must never take that path.
 */
export async function hasCommitsAhead(cwd: string, baseRef: string, headRef = "HEAD"): Promise<boolean> {
  const ahead = await commitsAhead(cwd, baseRef, headRef);
  if (ahead === null) {
    console.warn(`[git] could not count commits of ${headRef} ahead of ${baseRef} in ${cwd} — assuming it has commits`);
    return true;
  }
  return ahead > 0;
}
