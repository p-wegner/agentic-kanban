/**
 * #1209: detect a resolve-conflicts session that exited having done nothing.
 *
 * Before the fix in `workspace-merge.service.ts`, `resolveConflicts` spawned the agent into a
 * CLEAN worktree — no rebase or merge in progress — so the agent truthfully reported "nothing to
 * resolve" and exited 0. The exit handler then retried the merge, which ran a gate on a branch
 * that still conflicted with its base. Now that `resolveConflicts` puts the worktree into the
 * conflicted state before spawning, a genuinely-idle/confused session looks the same way at
 * exit: the branch tip is exactly where the pre-session snapshot recorded it, AND the branch
 * still conflicts with its base. Both conditions have to hold — a session that advanced the
 * rebase and then hit an unrelated conflict on a later commit has a DIFFERENT tip and is not a
 * no-op; a session that moved the tip back to the same sha by coincidence but resolved the
 * conflict is not withheld either, since the second condition already false.
 */

/** Pure verdict — see the module doc for why both conditions are required. */
export function isResolveConflictsNoop(input: {
  headShaBeforeSession: string | null;
  headShaAfterSession: string | null;
  stillConflicting: boolean;
}): boolean {
  const { headShaBeforeSession, headShaAfterSession, stillConflicting } = input;
  if (!stillConflicting) return false;
  if (!headShaBeforeSession || !headShaAfterSession) return false;
  return headShaBeforeSession === headShaAfterSession;
}
