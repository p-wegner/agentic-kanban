import type { RepoLockStatus } from "@agentic-kanban/shared/lib/repo-lock";

/**
 * #764 — the CROSS-PROCESS half of `mergeWorkspace`'s refuse/reuse pre-check.
 *
 * `mergeWorkspace` refuses a merge whose repo is already being merged, and it does that
 * check BEFORE the pre-lock verify gate for a stated reason (see the comment at the gate
 * call site): "when another merge is already in flight this call is going to be refused
 * anyway, and gating first would burn a full test run to produce that refusal."
 *
 * That pre-check read only the in-process `activeMerges` map. #993 added the on-disk repo
 * lock as the cross-process source of truth and taught the BACKGROUND scanner
 * (`done-unmerged-invariant-sweep`) to consult it, with the note that a cross-process
 * holder "has no in-process `activeMerges` entry, so it would otherwise be invisible
 * here". The primary, operator-facing merge path never got the same treatment — so a repo
 * held by a Conductor-loop agent's own git, a merge in a second server process surviving a
 * hot-reload, or a human running git by hand looked FREE to the pre-check. The merge then
 * ran the full verify gate (20-40 min on this repo, per the gate's own comment) and only
 * afterwards blocked inside `acquireOnDiskRepoLock` — for up to 90 minutes — exactly the
 * outcome the pre-check ordering exists to avoid.
 *
 * This is the decision half only, kept pure so the precedence between "reclaimable" and
 * "genuinely held" is table-testable: `inspectRepoLock` does the I/O, the caller raises
 * the `WorkspaceError`.
 */
export interface CrossProcessMergeHolder {
  holder: string;
  pid: number;
  hostname: string;
  ageMs: number;
}

/**
 * Should `mergeWorkspace` refuse immediately because ANOTHER process holds the repo lock?
 *
 * Returns the holder to report, or `null` when the merge should proceed to the gate.
 * Refuses only for a lock that is actually load-bearing:
 * - `null` lock — nothing held.
 * - our OWN workspace's lock — the in-memory reuse path above owns that case; a leftover
 *   on-disk entry for this same workspace must not turn a retry into a permanent refusal.
 * - `ownerProcessDead` — a same-host holder whose pid is gone. `tryAcquireRepoLock`
 *   reclaims it, so refusing here would block on a lock nobody holds.
 * - `isStale` — past the heartbeat window and NOT provably alive, i.e. the normal recovery
 *   paths get their chance. A stale heartbeat from a pid that IS still running
 *   (`ownerProcessAlive`) is deliberately still a refusal: #970 established that reclaiming
 *   over a live holder is the more expensive mistake.
 */
export function describeCrossProcessMergeHolder(
  diskLock: RepoLockStatus | null,
  selfWorkspaceId: string,
): CrossProcessMergeHolder | null {
  if (!diskLock) return null;
  if (diskLock.contents.holder === repoLockHolderFor(selfWorkspaceId)) return null;
  if (diskLock.ownerProcessDead) return null;
  if (diskLock.isStale && !diskLock.ownerProcessAlive) return null;
  return {
    holder: diskLock.contents.holder,
    pid: diskLock.contents.pid,
    hostname: diskLock.contents.hostname,
    ageMs: diskLock.ageMs,
  };
}

/**
 * The holder label `acquireOnDiskRepoLock` writes into the lockfile. Exported so the
 * pre-check compares against the SAME string the acquirer stamps rather than a second
 * copy of the format that could drift.
 */
export function repoLockHolderFor(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}
