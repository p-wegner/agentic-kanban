import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { createTtlMemo } from "@agentic-kanban/shared/lib/ttl-memo";

/**
 * Skip a gate run for a tree that was already gated green (#492, item 2).
 *
 * The measured problem: five ready branches cost five full suite runs at ~42 min wall each,
 * mostly re-running the same 5146 tests against the same code. Nothing reused a result across
 * branches, and — more wastefully — nothing reused one across an UNCHANGED TREE. A rebase that
 * changes no content still produced a different commit, so the queue re-gated from scratch.
 *
 * `git merge-tree --write-tree <base> HEAD` gives the tree object id the merge WOULD produce,
 * without merging. That id is an exact content fingerprint: two branches whose merge yields the
 * same tree are, at the file level, the same code. If that tree already passed, running the
 * suite again asks a question we have the answer to.
 *
 * **Only passes are remembered, and only in memory.** A failure can be environmental (a flake,
 * a timeout, a saturated box — see #620), so caching one would withhold merges on evidence that
 * may not hold; a false red is cheap to re-run, a false green is not. In-memory because the
 * value is in draining a queue back-to-back, which is one process's lifetime, and because a
 * durable store would need a migration plus an invalidation story for a claim that is only ever
 * an optimisation.
 *
 * This does NOT implement the ticket's item 1 (gate the queue on a staging ref and land the
 * batch together). That is the larger win and the larger change; this is the cheap exact half.
 */

/** ~2h: long enough to drain a merge queue, short enough that a stale claim ages out. */
const TREE_MEMO_TTL_MS = 2 * 60 * 60 * 1000;

const passedTrees = createTtlMemo<string, true>({ ttlMs: TREE_MEMO_TTL_MS });

/** Scoped by project: the same tree in two projects is gated by two different verify scripts. */
const memoKey = (projectId: string, treeHash: string) => `${projectId}:${treeHash}`;

/**
 * The tree `baseBranch` merged with the worktree's HEAD would produce, or null when it cannot
 * be determined — no worktree, no base, an old git, or a CONFLICTING merge (`merge-tree` exits
 * non-zero and prints the conflict, which is not a tree id).
 *
 * Null always means "do not memoize"; it never means "skip the gate".
 */
export async function mergedTreeHash(
  workingDir: string | null | undefined,
  baseBranch: string | null | undefined,
): Promise<string | null> {
  if (!workingDir || !baseBranch) return null;
  const result = await gitExec(["merge-tree", "--write-tree", baseBranch, "HEAD"], { cwd: workingDir });
  if (result.code !== 0) return null;
  const hash = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  // A tree id and nothing else. `merge-tree` prints conflict bodies on some paths, and a
  // partial match there would key the memo on garbage.
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** Has this exact merged tree already passed the gate for this project? */
export function wasTreeGatedGreen(projectId: string, treeHash: string | null): boolean {
  if (!treeHash) return false;
  return passedTrees.get(memoKey(projectId, treeHash)) === true;
}

/** Record a PASS. Callers must not record failures — see the header. */
export function rememberTreeGatedGreen(projectId: string, treeHash: string | null): void {
  if (!treeHash) return;
  passedTrees.set(memoKey(projectId, treeHash), true);
}

/** Drop every remembered tree — for tests, and for an operator forcing a full re-gate. */
export function __resetTreeGateMemoForTests(): void {
  passedTrees.clear();
}
