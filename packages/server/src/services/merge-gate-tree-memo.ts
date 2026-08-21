import { createHash } from "node:crypto";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { createTtlMemo } from "@agentic-kanban/shared/lib/ttl-memo";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

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

/**
 * Scoped by project AND by what verification the pass actually bought.
 *
 * `projectId` alone was not enough. The header reasons only about CROSS-project verify
 * differences, but the same project's verification changes over TIME: an operator switches
 * `verify_gate_strategy` from `scoped` to `full`, or tightens `verify_script`. The memo was
 * also consulted BEFORE either of those resolved, so within the 2 h TTL a pass banked under
 * the weaker setting was replayed under the stronger one — a level silently weakening
 * verification, which is the one thing the tier rules say it may never do.
 *
 * `verificationKey` is the tier plus the effective verify command, so tightening either one
 * cannot reuse a pass earned under the looser one. The tree hash still carries the base commit
 * by content (a moved base changes the merged tree).
 */
const memoKey = (projectId: string, treeHash: string, verificationKey: string) =>
  `${projectId}:${verificationKey}:${treeHash}`;

/**
 * Fold the tier and the verify command into one opaque key component. Hashed rather than
 * embedded so a command containing `:` cannot shift the key's field boundaries.
 */
/**
 * The separator is the ESCAPE `\0`, not a literal NUL byte in the source (#682-adjacent).
 * A raw NUL made git and grep classify this whole file as BINARY: its diffs showed as
 * `Bin 3680 -> 5050 bytes` in review, and `grep`/`rg` reported "Binary file matches" instead of
 * the line — so every change to the merge-gate memo was unreviewable by the usual tools. The
 * escape produces the identical byte in the string at runtime.
 */
export function gateVerificationKey(strategy: string, verifyCommand: string | null): string {
  return createHash("sha256").update(`${strategy}\0${verifyCommand ?? ""}`).digest("hex").slice(0, 16);
}

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
  if (!execSucceeded(result)) return null;
  const hash = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  // A tree id and nothing else. `merge-tree` prints conflict bodies on some paths, and a
  // partial match there would key the memo on garbage.
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * Fold every repo a workspace spans into ONE content fingerprint (#677). A multi-repo
 * workspace lands sibling-repo code alongside the leading repo (`executeSiblingMerges`), so a
 * memo keyed on the leading tree alone would let a branch whose leading diff is unchanged but
 * whose sibling diff differs reuse a PASS that never saw that sibling code. Every entry must
 * resolve to a hash or the whole thing is null (do-not-memoize) â€” a sibling this can't fingerprint
 * is exactly the case the memo must not paper over.
 */
export async function combinedMergedTreeHash(
  entries: ReadonlyArray<{ workingDir: string | null | undefined; baseBranch: string | null | undefined }>,
): Promise<string | null> {
  const hashes: string[] = [];
  for (const entry of entries) {
    const hash = await mergedTreeHash(entry.workingDir, entry.baseBranch);
    if (!hash) return null;
    hashes.push(hash);
  }
  return hashes.join("|");
}

/** Has this exact merged tree already passed the gate for this project, under the SAME
 *  tier + verify command? See `memoKey`. */
export function wasTreeGatedGreen(projectId: string, treeHash: string | null, verificationKey: string): boolean {
  if (!treeHash) return false;
  return passedTrees.get(memoKey(projectId, treeHash, verificationKey)) === true;
}

/** Record a PASS. Callers must not record failures — see the header. */
export function rememberTreeGatedGreen(projectId: string, treeHash: string | null, verificationKey: string): void {
  if (!treeHash) return;
  passedTrees.set(memoKey(projectId, treeHash, verificationKey), true);
}

/** Drop every remembered tree — for tests, and for an operator forcing a full re-gate. */
export function __resetTreeGateMemoForTests(): void {
  passedTrees.clear();
}
