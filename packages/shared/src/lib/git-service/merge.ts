import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "../git-exec.js";
import { execGit, splitGitLines } from "./internal.js";
import { getCurrentBranch, isAncestor } from "./branch.js";
import { getUncommittedTrackedChanges } from "./history.js";
import { readBlobAtRef, resolveAppendOnlyFile } from "./append-resolve.js";

/**
 * Scan a git tree object for files whose blob content contains conflict markers.
 * Uses `git grep` on the tree SHA — never touches the working tree.
 * When `pathspecs` is provided, only those files are scanned (avoids false positives
 * from pre-existing files in master that legitimately contain "<<<<<<<" in docs/tests).
 * Returns an array of conflicting file paths (empty = no markers found).
 */
async function scanTreeForConflictMarkers(repoPath: string, treeSha: string, pathspecs?: string[]): Promise<string[]> {
  // git grep exits 0 when matches found, 1 when no matches, 128+ on error.
  // We treat all errors as "no markers" (safe default — the stage-entry check
  // is the primary gate; this is belt-and-suspenders only).
  // Use --perl-regexp with ^ anchor so we only match lines where "<<<<<<<" starts
  // the line (i.e. actual git conflict markers), not string literals or comments
  // that happen to contain the substring.
  const args = ["grep", "--name-only", "-l", "--perl-regexp", "-e", "^<<<<<<<", treeSha];
  if (pathspecs && pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  const { stdout } = await gitExec(args, { cwd: repoPath });
  const output = stdout.trim();
  if (!output) return [];
  // Output format: "<treeSha>:<filepath>", one per line.
  // Exclude .md files — they legitimately document conflict marker syntax
  // (e.g. SKILL.md files that describe how to resolve conflicts).
  return output.split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/^[^:]+:/, "").trim())
    .filter(Boolean)
    .filter((f) => !f.endsWith(".md"));
}

/**
 * Thrown when advancing the target branch ref fails its compare-and-swap check:
 * an external commit landed on the target branch between reading its tip (the
 * merge computation's base) and `git update-ref`. Advancing anyway would orphan
 * that external commit — the historical "silent merge loss" class (#980). The
 * merge computation itself is sound; retrying against the new tip is safe.
 */
export class RefAdvanceRaceError extends Error {
  /** Recomputing the merge against the branch's new tip is safe. */
  readonly retryable = true;

  constructor(
    readonly targetBranch: string,
    /** The target tip the merge was computed against. */
    readonly expectedSha: string,
    /** The tip actually found on the branch at update-ref time (null if unreadable). */
    readonly actualSha: string | null,
  ) {
    super(
      `Merge aborted: refs/heads/${targetBranch} moved during the merge ` +
        `(expected ${expectedSha.slice(0, 12)}, found ${actualSha ? actualSha.slice(0, 12) : "unknown"}). ` +
        `An external commit landed on ${targetBranch} after the merge was computed; ` +
        `advancing the ref anyway would silently orphan it. Retry the merge against the new tip.`,
    );
    this.name = "RefAdvanceRaceError";
  }
}

/**
 * Advance `refs/heads/<targetBranch>` to `newSha` with git's compare-and-swap:
 * `git update-ref <ref> <new> <expected-old>` atomically refuses when the ref no
 * longer points at `expectedOldSha`. On CAS failure throws {@link RefAdvanceRaceError};
 * any other update-ref failure propagates as a normal error.
 */
async function advanceRefWithCas(
  repoPath: string,
  targetBranch: string,
  newSha: string,
  expectedOldSha: string,
): Promise<void> {
  const ref = `refs/heads/${targetBranch}`;
  const { stderr, code, error } = await gitExec(
    ["update-ref", ref, newSha, expectedOldSha],
    { cwd: repoPath },
  );
  if (code === 0 && !error) return;

  // Distinguish the CAS race (ref moved) from other update-ref failures (locks, perms).
  const { stdout: actualOut } = await gitExec(["rev-parse", "--verify", ref], { cwd: repoPath });
  const actualSha = actualOut.trim() || null;
  if (actualSha !== expectedOldSha) {
    throw new RefAdvanceRaceError(targetBranch, expectedOldSha, actualSha);
  }
  throw new Error(
    `git update-ref ${ref} failed: ${stderr.trim() || error?.message || `exit code ${code}`}`,
  );
}

/** Hash a string into the object DB as a blob and return its SHA. */
async function hashObjectFromStdin(repoPath: string, content: string): Promise<string> {
  const stdout = await gitExecOrThrow(["hash-object", "-w", "--stdin"], { cwd: repoPath, input: content });
  return stdout.trim();
}

/**
 * Attempt to resolve an append-only merge conflict between two branches (#763).
 *
 * For every conflicting file, fetch its merge-base / target / feature versions and
 * check it is a pure append (see {@link resolveAppendOnlyFile}). If EVERY conflicting
 * file qualifies, build the merged tree from the target's tree with the concatenated
 * blobs substituted in, create a merge commit (two parents), and return its SHA. If any
 * file is a non-append conflict — or the conflicting-file list is unknown — return null
 * so the caller falls back to throwing.
 */
async function tryResolveAppendOnlyMerge(
  repoPath: string,
  targetBranch: string,
  featureBranch: string,
  conflictingFiles: string[],
  /**
   * The conflicted merged tree from `git merge-tree --write-tree` (#763). It already
   * carries the correct 3-way merge of EVERY non-conflicting file — including any file
   * the feature branch added or edited cleanly — with conflict markers only in the
   * conflicting (append) paths. We seed the scratch index from THIS tree and overwrite
   * just the conflicting blobs, so the feature branch's clean changes are preserved.
   * Seeding from the target tree instead would silently drop them (silent merge loss).
   */
  mergedTreeSha: string,
): Promise<{ commitSha: string; targetSha: string; resolvedFiles: string[] } | null> {
  if (conflictingFiles.length === 0) return null;

  const targetSha = (await execGit(["rev-parse", targetBranch], repoPath)).trim();
  const featureSha = (await execGit(["rev-parse", featureBranch], repoPath)).trim();
  let baseSha: string;
  try {
    baseSha = (await execGit(["merge-base", targetBranch, featureBranch], repoPath)).trim();
  } catch {
    return null;
  }
  if (!baseSha) return null;

  const resolutions: { path: string; content: string }[] = [];
  for (const path of conflictingFiles) {
    const [base, target, feature] = await Promise.all([
      readBlobAtRef(repoPath, baseSha, path),
      readBlobAtRef(repoPath, targetSha, path),
      readBlobAtRef(repoPath, featureSha, path),
    ]);
    const merged = resolveAppendOnlyFile(base, target, feature);
    if (merged === null) return null; // a non-append conflict — bail, throw normally
    resolutions.push({ path, content: merged });
  }

  // Start from the conflicted MERGED tree (the proper 3-way merge of every other file,
  // incl. the feature branch's clean additions/edits) and overwrite just the resolved
  // append blobs via `git read-tree`/`update-index` in a temp index. Seeding from the
  // target tree instead would drop the feature's non-conflicting changes (#763).
  // Using a scratch index file keeps the real index untouched (safe alongside a checkout).
  const scratchIndex = join(repoPath, ".git", `append-merge-index-${targetSha.slice(0, 8)}`);
  const indexEnvGit = (args: string[]) =>
    gitExecOrThrow(args, { cwd: repoPath, env: { ...process.env, GIT_INDEX_FILE: scratchIndex } });

  try {
    await indexEnvGit(["read-tree", mergedTreeSha]);
    for (const { path, content } of resolutions) {
      const blobSha = await hashObjectFromStdin(repoPath, content);
      await indexEnvGit(["update-index", "--cacheinfo", `100644,${blobSha},${path}`]);
    }
    const mergedTree = (await indexEnvGit(["write-tree"])).trim();
    const commitSha = (await execGit(
      ["commit-tree", mergedTree, "-p", targetSha, "-p", featureSha, "-m", `Merge branch '${featureBranch}' (append-only auto-resolve)`],
      repoPath,
    )).trim();
    return { commitSha, targetSha, resolvedFiles: resolutions.map((r) => r.path) };
  } catch {
    return null;
  } finally {
    await rm(scratchIndex, { force: true }).catch(() => undefined);
  }
}

/**
 * Merge a feature branch into targetBranch using git plumbing commands only.
 *
 * Steps:
 *   1. merge-tree --write-tree  → compute merged tree (read-only)
 *   2. commit-tree              → create the merge commit object
 *   3. update-ref               → atomically advance the target branch ref
 *
 * Working-tree handling:
 * - If `targetBranch` is NOT the branch checked out in `repoPath`, the working
 *   tree and index are left untouched — safe alongside running dev servers / DB
 *   connections (no file-watcher noise, no DB-lock window).
 * - If `targetBranch` IS the branch checked out in `repoPath` (the usual case for
 *   the main checkout on `master`), advancing the ref alone would leave the
 *   working tree at the OLD commit — a silent desync where the next commit
 *   reverts the merge. In that case the working tree is synced to the new merge
 *   commit (`git reset --hard`). To avoid discarding real work, the merge is
 *   refused up-front if that checked-out branch has uncommitted tracked changes.
 * - `options.syncWorkingTree` forces the sync (e.g. for a worktree an agent
 *   continues to use even when its branch isn't the merge target).
 *
 * Throws with the conflicting file list on merge conflicts.
 */
export async function mergeBranch(
  repoPath: string,
  featureBranch: string,
  targetBranch: string,
  options?: {
    syncWorkingTree?: boolean;
    deferWorkingTreeSync?: boolean;
    /**
     * When true, a conflict whose conflicting files are ALL pure-append (both the
     * target and the feature branch only appended distinct trailing content to a
     * shared-ancestor file, with no edits to existing lines) is auto-resolved by
     * concatenating both sides' appended tails instead of throwing (#763). Used to
     * stop fix-and-merge thrash on append-only "hot files" (shared smoke tests, logs,
     * changelogs) that a whole wave of parallel tickets all append to. A conflict with
     * ANY non-append (edited/overlapping) file still throws as before.
     */
    autoResolveAppendConflicts?: boolean;
  },
): Promise<string> {
  const targetSha = (await execGit(["rev-parse", targetBranch], repoPath)).trim();
  const featureSha = (await execGit(["rev-parse", featureBranch], repoPath)).trim();

  // Is targetBranch the branch currently checked out in repoPath's working tree?
  // If so, we must sync the working tree after advancing the ref (otherwise it
  // desyncs). Refuse first if there are uncommitted tracked changes, since the
  // sync (`reset --hard`) would discard them. `getCurrentBranch` returns "HEAD"
  // on a detached checkout — never a real branch name — so this stays false there.
  const checkedOutBranch = await getCurrentBranch(repoPath).catch(() => "");
  const targetIsCheckedOut = checkedOutBranch === targetBranch;

  // Idempotent retry path: a previous merge attempt may have advanced the
  // target ref, then been interrupted before the workspace DB row was closed.
  // If the feature is already reachable from the target, do not create another
  // merge commit. Still repair a desynced checked-out worktree when needed.
  if (await isAncestor(repoPath, featureSha, targetSha)) {
    const needsIdempotentSync = options?.syncWorkingTree || targetIsCheckedOut;
    let idempotentResetDeferred = false;
    if (needsIdempotentSync) {
      const currentHead = (await execGit(["rev-parse", "HEAD"], repoPath)).trim();
      const dirty = targetIsCheckedOut ? await getUncommittedTrackedChanges(repoPath) : [];
      const canResetDesyncedCheckout =
        targetIsCheckedOut && dirty.length > 0
          ? await canResetInterruptedMergeCheckout(repoPath, targetSha, featureSha)
          : false;
      const needsReset =
        currentHead !== targetSha ||
        canResetDesyncedCheckout;

      if (needsReset) {
        if (targetIsCheckedOut && dirty.length > 0 && !canResetDesyncedCheckout) {
          const preview = dirty.slice(0, 5).join(", ");
          const more = dirty.length > 5 ? ` (and ${dirty.length - 5} more)` : "";
          throw new Error(
            `Cannot sync already-merged '${targetBranch}' in ${repoPath}: it has ${dirty.length} uncommitted tracked change(s): ${preview}${more}. Commit or stash them first.`,
          );
        }
        if (!options?.deferWorkingTreeSync) {
          await syncWorkingTreeHard(repoPath, targetSha);
        } else {
          // Reset was skipped — caller must apply it post-response via applyDeferredWorkingTreeSync.
          idempotentResetDeferred = true;
        }
      } else {
        // No full reset is warranted (HEAD already matches the target), but a prior
        // interrupted merge may still have left tracked files DELETED in the working
        // tree (#692). Those deletions ARE the "uncommitted tracked change(s)" the
        // dirty check above counted, so they don't block the idempotent path — heal
        // them directly so the checkout is never left with HEAD's files missing.
        await restoreDeletedTrackedFiles(repoPath);
      }
    }

    // Only tag as deferred when a reset was actually skipped — when HEAD already matches
    // targetSha we ran restoreDeletedTrackedFiles synchronously, so no deferred sync is
    // needed and no tag should trigger a redundant git reset --hard in post-merge cleanup.
    const idempotentDeferTag = idempotentResetDeferred
      ? ` [pending-wt-sync:${targetSha}]`
      : "";
    return `Branch '${featureBranch}' is already merged into ${targetBranch} (plumbing-merge: ${targetSha})${idempotentDeferTag}`;
  }

  if (targetIsCheckedOut) {
    const dirty = await getUncommittedTrackedChanges(repoPath);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).join(", ");
      const more = dirty.length > 5 ? ` (and ${dirty.length - 5} more)` : "";
      throw new Error(
        `Cannot merge into '${targetBranch}': it is checked out in ${repoPath} with ${dirty.length} uncommitted tracked change(s): ${preview}${more}. Commit or stash them first.`,
      );
    }
  }

  // merge-tree computes the merged tree without touching the working tree.
  // Exit 0 = clean, exit 1 = conflicts; stdout always has the tree SHA on line 1.
  // NOTE: --no-messages is intentionally omitted so stdout stage entries (which we
  // parse for conflict detection) are never suppressed by a git version quirk.
  const { treeSha, conflictingFiles, mergeTreeHadConflictExit } = await (async (): Promise<{
    treeSha: string;
    conflictingFiles: string[];
    mergeTreeHadConflictExit: boolean;
  }> => {
    const { stdout, stderr, error, code } = await gitExec(
      ["merge-tree", "--write-tree", targetBranch, featureBranch],
      { cwd: repoPath },
    );
    const output = stdout.trim();
    // git merge-tree exits 1 for conflicts (expected, output still valid).
    // A real failure (exit 128+) produces no usable output — propagate the
    // git error instead of a misleading "no output" message.
    if (error && !output) {
      throw new Error(`git merge-tree --write-tree failed: ${stderr.trim() || error.message}`);
    }
    const lines = output.split("\n").filter(Boolean);
    const treeSha = lines[0]?.trim() ?? "";
    if (!treeSha) {
      throw new Error(`git merge-tree produced no output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    // Stage 1/2/3 entries indicate conflicting files: "<mode> <sha> <stage>\t<file>"
    const seen = new Set<string>();
    for (const line of lines.slice(1)) {
      const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
      if (m) seen.add(m[1].replace(/\r$/, ""));
    }
    // Track whether git itself reported a conflict exit (belt-and-suspenders).
    const mergeTreeHadConflictExit = code === 1;
    return { treeSha, conflictingFiles: [...seen], mergeTreeHadConflictExit };
  })();

  // #763: when the ONLY conflicts are pure-append hot files (both sides appended
  // distinct trailing content to a shared-ancestor file, no edits to existing lines),
  // resolve them by concatenating both tails instead of throwing — provided the caller
  // opted in. This lands a wave of parallel tickets that all append to one shared file
  // (a smoke test, changelog, log) without fix-and-merge thrash. Any non-append conflict
  // falls through to the normal throw.
  if ((conflictingFiles.length > 0 || mergeTreeHadConflictExit) && options?.autoResolveAppendConflicts) {
    const resolved = await tryResolveAppendOnlyMerge(
      repoPath,
      targetBranch,
      featureBranch,
      conflictingFiles,
      treeSha,
    );
    if (resolved) {
      // CAS against the tip the resolved merge commit was actually parented on
      // (re-read inside tryResolveAppendOnlyMerge) — an external commit landing
      // after that read must fail loudly, never be orphaned (#980).
      await advanceRefWithCas(repoPath, targetBranch, resolved.commitSha, resolved.targetSha);
      const needsSync = options?.syncWorkingTree || targetIsCheckedOut;
      if (needsSync && !options?.deferWorkingTreeSync) {
        await syncWorkingTreeHard(repoPath, resolved.commitSha);
      }
      const deferTag = needsSync && options?.deferWorkingTreeSync
        ? ` [pending-wt-sync:${resolved.commitSha}]`
        : "";
      return `Merge branch '${featureBranch}' into ${targetBranch} (append-merge: ${resolved.commitSha}; concatenated ${resolved.resolvedFiles.join(", ")})${deferTag}`;
    }
  }

  if (conflictingFiles.length > 0) {
    throw new Error(`Merge conflict in: ${conflictingFiles.join(", ")}`);
  }

  // Belt-and-suspenders: even if no stage entries were emitted, scan the written
  // tree for conflict marker blobs before committing. This catches cases where the
  // git version emits conflict markers into blob content without stage entries
  // (observed in production: commit 4bf8c52c contained raw markers).
  // We also scan when git exited with code 1 (conflict exit) regardless of stage entries.
  if (mergeTreeHadConflictExit) {
    throw new Error(`Merge conflict detected (git merge-tree exit 1) in ${featureBranch} → ${targetBranch}: stage entries may be missing. Aborting to prevent committing conflict markers.`);
  }

  // Secondary scan: check only files changed by featureBranch for conflict markers.
  // Scoping to changed files prevents false positives from pre-existing files in
  // targetBranch that legitimately contain "<<<<<<" (docs, tests, skill files).
  const changedFiles = (await execGit(
    ["diff", "--name-only", `${targetBranch}...${featureBranch}`],
    repoPath,
  )).trim().split("\n").map((f) => f.replace(/\r$/, "")).filter(Boolean);
  const conflictingFilesFromTree = changedFiles.length > 0
    ? await scanTreeForConflictMarkers(repoPath, treeSha, changedFiles)
    : [];
  if (conflictingFilesFromTree.length > 0) {
    throw new Error(`Merge conflict markers found in tree for: ${conflictingFilesFromTree.join(", ")}`);
  }

  // Create the merge commit with two parents
  const newCommitSha = (await execGit(
    ["commit-tree", treeSha, "-p", targetSha, "-p", featureSha, "-m", `Merge branch '${featureBranch}'`],
    repoPath,
  )).trim();

  // Atomically advance the target branch ref, compare-and-swap against the tip the
  // merge was computed from (#980). If an external commit landed on the target branch
  // between the rev-parse above and now, git refuses the update and we fail loudly
  // (RefAdvanceRaceError) instead of silently orphaning that commit.
  await advanceRefWithCas(repoPath, targetBranch, newCommitSha, targetSha);

  // Sync the working tree to the new merge commit when the target branch is
  // checked out here (otherwise repoPath silently desyncs), or when a caller
  // explicitly requests it (a worktree the agent keeps using). When the target
  // branch is not checked out, the working tree is correctly left untouched.
  //
  // deferWorkingTreeSync lets the caller skip this synchronous file-system write
  // during an HTTP request and perform it later (e.g. in a setImmediate callback)
  // so that tsx hot-reload triggered by the new files doesn't kill the connection
  // before the response is sent.
  const needsWorkingTreeSync = options?.syncWorkingTree || targetIsCheckedOut;
  if (needsWorkingTreeSync && !options?.deferWorkingTreeSync) {
    await syncWorkingTreeHard(repoPath, newCommitSha);
  }

  const deferTag = needsWorkingTreeSync && options?.deferWorkingTreeSync
    ? ` [pending-wt-sync:${newCommitSha}]`
    : "";
  return `Merge branch '${featureBranch}' into ${targetBranch} (plumbing-merge: ${newCommitSha})${deferTag}`;
}

/**
 * Extract the deferred working-tree sync SHA embedded in a `mergeBranch` result
 * string by `deferWorkingTreeSync: true`. Returns null when no sync is pending.
 *
 * Format: "... [pending-wt-sync:<sha>]"
 */
export function extractPendingWorkingTreeSync(mergeOutput: string): string | null {
  const m = mergeOutput.match(/\[pending-wt-sync:([0-9a-f]{7,40})\]/);
  return m ? m[1] : null;
}

/**
 * Perform the working-tree sync that was deferred by `mergeBranch({ deferWorkingTreeSync: true })`.
 * Safe to call from a `setImmediate` after the HTTP response is flushed — by then
 * tsx hot-reload triggered by the new files won't kill the in-flight connection.
 */
export async function applyDeferredWorkingTreeSync(repoPath: string, commitSha: string): Promise<void> {
  await syncWorkingTreeHard(repoPath, commitSha);
}

/**
 * Hard-sync the main checkout's working tree + index to `commitSha`, guaranteeing
 * the working tree is never left with tracked files DELETED relative to HEAD.
 *
 * `git reset --hard` first moves HEAD, then overwrites the working tree from the
 * new tree. If that second phase is interrupted (a dropped connection that fails
 * the merge request mid-flight, a transient FS/lock error, a partially-applied
 * checkout), the checkout can be left with files on disk removed while HEAD still
 * references them — exactly the failure in #692, where a merge that did not land
 * cleanly left `packages/shared/drizzle/*` (and friends) showing as deleted in the
 * main checkout and the monitor had to `git restore` them from HEAD before the
 * server would start.
 *
 * #771 — `commitSha` MUST descend from the checkout's current HEAD. A blanket
 * `git reset --hard <sha>` rewrites the ENTIRE working tree to `<sha>`'s tree,
 * deleting any tracked path absent there. When `<sha>` is STALE or REGRESSIVE
 * relative to HEAD — a deferred sync whose SHA was computed before a concurrent
 * merge advanced the branch, or a feature tip cut from an old base — that wipes
 * unrelated paths off disk (observed: the entire `packages/shared` source tree,
 * 100-154 files, gone → backend crash). So before resetting we verify `commitSha`
 * is a descendant of the current HEAD; if it is not, we DON'T reset to it (that
 * would discard committed history on disk). Instead we sync forward to HEAD (the
 * authoritative branch tip), which can only ever ADD the merge's new files, never
 * delete an unrelated tree. The reset then only ever touches the genuine
 * HEAD..disk delta.
 *
 * After the reset we still self-heal any leftover deletion (the #692 interrupted
 * case) by restoring tracked paths that are deleted relative to HEAD. If the reset
 * itself throws, we attempt the restore anyway so the caller never observes a
 * checkout with tracked files missing — then re-raise so the merge is reported as
 * failed rather than silently half-applied.
 */
async function syncWorkingTreeHard(repoPath: string, commitSha: string): Promise<void> {
  const syncTarget = await resolveSafeSyncTarget(repoPath, commitSha);
  try {
    await execGit(["reset", "--hard", syncTarget], repoPath);
  } catch (err) {
    await restoreDeletedTrackedFiles(repoPath);
    throw err;
  }
  await restoreDeletedTrackedFiles(repoPath);
}

/**
 * Pick a working-tree sync target that can never delete unrelated tracked paths (#771).
 *
 * The safe target is whichever of `commitSha` / the checked-out HEAD is a DESCENDANT
 * of the other (the strictly newer commit reachable on the branch). Resetting to an
 * ancestor of HEAD would roll the working tree backward and delete every file added
 * since — the mass-deletion failure. So:
 *   - `commitSha` is HEAD or a descendant of HEAD → use it (normal forward merge).
 *   - HEAD descends from `commitSha` (a stale deferred SHA; a concurrent merge already
 *     advanced the branch past it) → use HEAD instead; it already contains commitSha's
 *     tree plus the concurrent merge, so the working tree only moves forward.
 *   - neither descends from the other (divergent/garbage SHA) → refuse to reset to
 *     commitSha and fall back to HEAD, the authoritative checked-out tip.
 * Best-effort: any rev-parse failure falls back to commitSha (the prior behavior).
 */
async function resolveSafeSyncTarget(repoPath: string, commitSha: string): Promise<string> {
  let headSha: string;
  try {
    headSha = (await execGit(["rev-parse", "HEAD"], repoPath)).trim();
  } catch {
    return commitSha;
  }
  if (!headSha || headSha === commitSha) return commitSha;

  // commitSha already contains HEAD's history (forward merge) → safe to reset to it.
  if (await isAncestor(repoPath, headSha, commitSha)) return commitSha;

  // HEAD is newer than commitSha (stale/deferred SHA) or the two diverged — reset to
  // commitSha would drop files only present on HEAD. Sync to HEAD, never backward.
  console.warn(
    `[git] working-tree sync target ${commitSha.slice(0, 12)} is not a descendant of the ` +
      `checked-out HEAD ${headSha.slice(0, 12)} in ${repoPath}; syncing to HEAD instead to ` +
      `avoid deleting tracked files added since ${commitSha.slice(0, 12)}.`,
  );
  return headSha;
}

/**
 * Restore any tracked files that are deleted from the working tree but still
 * present in HEAD (a desynced checkout). No-op when the working tree is consistent.
 * Best-effort: a failure here must not mask the caller's own error.
 */
async function restoreDeletedTrackedFiles(repoPath: string): Promise<void> {
  try {
    const out = await execGit(["diff", "--name-only", "--diff-filter=D", "HEAD"], repoPath);
    const deleted = splitGitLines(out);
    if (deleted.length === 0) return;
    // `checkout -- <paths>` repopulates the working tree from the index/HEAD for
    // exactly the missing files, without disturbing other working-tree state.
    await execGit(["checkout", "--", ...deleted], repoPath);
    console.warn(
      `[git] restored ${deleted.length} tracked file(s) deleted from the working tree after a hard sync in ${repoPath}: ` +
        deleted.slice(0, 5).join(", ") + (deleted.length > 5 ? ` (and ${deleted.length - 5} more)` : ""),
    );
  } catch (err) {
    console.warn(
      `[git] failed to restore deleted tracked files in ${repoPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function canResetInterruptedMergeCheckout(repoPath: string, targetSha: string, featureSha: string): Promise<boolean> {
  try {
    const secondParent = (await execGit(["rev-parse", `${targetSha}^2`], repoPath)).trim();
    if (secondParent !== featureSha) return false;
    await execGit(["diff-files", "--quiet"], repoPath);
    const indexTree = (await execGit(["write-tree"], repoPath)).trim();
    const firstParentTree = (await execGit(["rev-parse", `${targetSha}^1^{tree}`], repoPath)).trim();
    const targetTree = (await execGit(["rev-parse", `${targetSha}^{tree}`], repoPath)).trim();
    return indexTree === firstParentTree && indexTree !== targetTree;
  } catch {
    return false;
  }
}

/**
 * Merge the base branch into the current workspace branch.
 * On conflict, returns conflicting files and leaves merge in-progress for resolution.
 */
export async function mergeBaseIntoBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
    source = `origin/${baseBranch}`;
  } catch { /* use local */ }

  try {
    await execGit(["merge", source, "--no-edit"], worktreePath);
    return { success: true };
  } catch (err) {
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      const conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
      return { success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
    } catch {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Abort an in-progress merge. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execGit(["merge", "--abort"], worktreePath);
}

/** Check if a merge is in progress (MERGE_HEAD exists). */
export async function isMergeInProgress(repoPath: string): Promise<boolean> {
  try {
    const dir = (await execGit(["rev-parse", "--git-dir"], repoPath)).trim();
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(repoPath, dir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}
