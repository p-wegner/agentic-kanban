import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, lstat, unlink, readdir } from "node:fs/promises";
import { join, dirname, sep, resolve, parse, relative } from "node:path";

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/**
 * List current git worktrees as an array of { path, branch } objects.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<{ path: string; branch: string }[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoPath);
  const worktrees: { path: string; branch: string }[] = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
    } else if (line === "" && currentPath) {
      worktrees.push({ path: currentPath, branch: currentBranch });
      currentPath = "";
      currentBranch = "";
    }
  }
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  return worktrees;
}

/**
 * Create a git worktree for a branch. The worktree is created in a
 * `.worktrees/<branch>` directory sibling to the repo root.
 * If the branch doesn't exist yet, it is created from the given baseBranch
 * (or HEAD if no baseBranch is specified).
 * Throws if a worktree for this branch already exists.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
): Promise<string> {
  // Prune stale worktree references (directories deleted but git still tracks them).
  // This is critical on Windows where locked directories can survive removal.
  try { await pruneWorktrees(repoPath); } catch { /* best effort */ }

  // Check if a worktree for this branch already exists — reuse if healthy
  const existing = await listWorktrees(repoPath);
  const match = existing.find(
    (wt) => wt.branch === branch || wt.branch === `refs/heads/${branch}`,
  );
  if (match) {
    // Verify the branch still exists — merged/deleted branches leave prunable worktrees
    try {
      await execGit(["rev-parse", "--verify", branch], repoPath);
      // Branch exists — reuse the worktree
      return match.path.replace(/\//g, sep);
    } catch {
      // Branch gone (merged away) — prune stale worktree and recreate.
      // Wrap in try/catch: on Windows the directory may be EBUSY/locked;
      // failure here is non-fatal — pruneWorktrees below cleans up the registration.
      try {
        await execGit(["worktree", "remove", "--force", match.path], repoPath);
      } catch {
        // EBUSY or locked — fall through; pruneWorktrees will tidy the registration
      }
    }
  }

  // Sanitize branch name for directory use
  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = join(dirname(repoPath), ".worktrees");
  let worktreePath = join(worktreesDir, safeName);

  await mkdir(worktreesDir, { recursive: true });

  // If the target directory exists but isn't a registered worktree (e.g. leftover from a
  // deleted workspace), remove it so git worktree add doesn't fail with "already exists".
  // On Windows, directories can be locked by stale process handles — if rm fails, fall back
  // to an alternative path with a numeric suffix.
  try {
    await stat(worktreePath);
    // Directory exists — try to remove it
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Locked on Windows — find an alternative path
      for (let suffix = 2; suffix <= 10; suffix++) {
        const altPath = join(worktreesDir, `${safeName}-${suffix}`);
        try {
          await stat(altPath);
          // Alt dir also exists — skip
        } catch {
          // This alt path is free — use it
          worktreePath = altPath;
          break;
        }
      }
    }
  } catch {
    // Directory doesn't exist — nothing to clean up
  }

  // Check if branch exists; if not, create it from baseBranch (or HEAD)
  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    const branchArgs = baseBranch ? ["branch", branch, baseBranch] : ["branch", branch];
    await execGit(branchArgs, repoPath);
  }

  await execGit(
    ["worktree", "add", worktreePath, branch],
    repoPath,
  );

  // Verify worktree is on the correct branch (not detached HEAD)
  await ensureOnBranch(worktreePath, branch);

  return worktreePath;
}

/** Remove a git worktree (force). */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  // Unlink junctions first so neither git nor the fs.rm fallback can traverse
  // into the main checkout via a Windows junction (data-loss bug #518).
  await unlinkTopLevelJunctions(worktreePath).catch(() => undefined);

  try {
    await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
  } catch (err) {
    if (await removeLeftoverWorktreeDirectory(repoPath, worktreePath)) {
      await execGit(["worktree", "prune"], repoPath).catch(() => undefined);
      return;
    }
    throw err;
  }

  if (await removeLeftoverWorktreeDirectory(repoPath, worktreePath)) {
    await execGit(["worktree", "prune"], repoPath).catch(() => undefined);
  }
}

/** Prune stale worktree references (worktrees whose directories no longer exist). */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await execGit(["worktree", "prune"], repoPath);
}

/**
 * Unlink any top-level symlinks/junctions in a directory WITHOUT recursing into them.
 * This prevents `fs.rm({ recursive })` from following a junction into the main checkout.
 */
async function unlinkTopLevelJunctions(dirPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      const st = await lstat(entryPath);
      if (st.isSymbolicLink()) {
        await unlink(entryPath);
      }
    } catch {
      // ignore — entry may have disappeared between readdir and lstat
    }
  }
}

async function removeLeftoverWorktreeDirectory(repoPath: string, worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;

  const repoResolved = resolve(repoPath);
  const targetResolved = resolve(worktreePath);
  const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
  const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
  const root = parse(targetResolved).root;
  const isInsideWorktreesRoot = relativeToWorktreesRoot !== ""
    && relativeToWorktreesRoot !== ".."
    && !relativeToWorktreesRoot.startsWith(`..${sep}`)
    && parse(relativeToWorktreesRoot).root === "";

  if (targetResolved === repoResolved || targetResolved === root || !isInsideWorktreesRoot) {
    throw new Error(`Refusing to recursively remove unsafe worktree path: ${worktreePath}`);
  }

  // Unlink top-level symlinks/junctions before recursive delete to prevent
  // fs.rm from following them into the main checkout (Windows junction data-loss bug).
  await unlinkTopLevelJunctions(worktreePath);

  await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return !existsSync(worktreePath);
}

/** Generate unified diff entries for untracked files (not yet git-add'd). */
async function getUntrackedDiffEntries(workdirPath: string): Promise<string> {
  const untrackedFiles = await execGit(["ls-files", "--others", "--exclude-standard"], workdirPath);
  if (!untrackedFiles.trim()) return "";

  const entries: string[] = [];
  for (const f of untrackedFiles.trim().split("\n").filter(Boolean)) {
    try {
      const content = await readFile(join(workdirPath, ...f.split("/")), "utf-8");
      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n"));
    } catch {
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
      ].join("\n"));
    }
  }
  return entries.join("\n");
}

/** Get a unified diff between the worktree's branch and a base branch, including untracked files. */
export async function getDiff(
  worktreePath: string,
  baseBranch: string = "main",
): Promise<string> {
  const tracked = await execGit(["diff", `${baseBranch}...HEAD`], worktreePath);
  const untracked = await getUntrackedDiffEntries(worktreePath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/** Get diff for a branch by name from the main repo (used when the worktree directory is gone). */
export async function getDiffFromRepo(
  repoPath: string,
  branch: string,
  baseBranch: string = "main",
): Promise<string> {
  return execGit(["diff", `${baseBranch}...${branch}`], repoPath);
}

/** List all local and remote branches, sorted by most recent committer date. */
export async function listBranches(
  repoPath: string,
): Promise<{ local: string[]; remote: string[] }> {
  const output = await execGit(["branch", "--all", "--sort=-committerdate"], repoPath);
  const local: string[] = [];
  const remote: string[] = [];

  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^\* /, "");
    if (!line) continue;

    if (line.startsWith("remotes/origin/")) {
      const name = line.slice("remotes/origin/".length).replace(/\r$/, "");
      if (name !== "HEAD") {
        remote.push(name);
      }
    } else {
      local.push(line.replace(/\r$/, ""));
    }
  }

  return { local, remote };
}

/** Delete a local branch. */
export async function deleteBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  try {
    await execGit(["branch", "-d", branch], repoPath);
  } catch (err) {
    if (!isBranchCheckedOutElsewhereError(err)) throw err;
    await pruneWorktrees(repoPath);
    await execGit(["branch", "-d", branch], repoPath);
  }
}

function isBranchCheckedOutElsewhereError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Cannot delete branch") && message.includes("checked out at");
}

/**
 * Scan a git tree object for files whose blob content contains conflict markers.
 * Uses `git grep` on the tree SHA — never touches the working tree.
 * When `pathspecs` is provided, only those files are scanned (avoids false positives
 * from pre-existing files in master that legitimately contain "<<<<<<<" in docs/tests).
 * Returns an array of conflicting file paths (empty = no markers found).
 */
async function scanTreeForConflictMarkers(repoPath: string, treeSha: string, pathspecs?: string[]): Promise<string[]> {
  return new Promise((resolve) => {
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
    execFile(
      "git",
      args,
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      (_err, stdout) => {
        const output = stdout.toString().trim();
        if (!output) {
          resolve([]);
          return;
        }
        // Output format: "<treeSha>:<filepath>", one per line.
        // Exclude .md files — they legitimately document conflict marker syntax
        // (e.g. SKILL.md files that describe how to resolve conflicts).
        const files = output.split("\n")
          .map((l) => l.replace(/\r$/, "").replace(/^[^:]+:/, "").trim())
          .filter(Boolean)
          .filter((f) => !f.endsWith(".md"));
        resolve(files);
      },
    );
  });
}

/** Read a blob's content at a given tree-ish path; returns null when the path is absent there. */
async function readBlobAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
  try {
    return await execGit(["show", `${ref}:${path}`], repoPath);
  } catch {
    return null;
  }
}

/** Hash a string into the object DB as a blob and return its SHA. */
function hashObjectFromStdin(repoPath: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["hash-object", "-w", "--stdin"],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git hash-object failed: ${stderr || err.message}`));
        else resolve(stdout.toString().trim());
      },
    );
    child.stdin?.end(content);
  });
}

/**
 * Decide whether a single file's conflict is a *pure append* and, if so, compute the
 * concatenated resolution. A pure-append conflict is one where the merge-base content
 * is a textual PREFIX of BOTH the target and feature versions — i.e. each side only
 * added lines at the tail and neither edited any existing line. The resolution keeps
 * the shared base, then appends the target's new tail followed by the feature's new
 * tail (target-first is deterministic and matches "base already advanced, replay
 * feature's addition after it"). Returns null when the file isn't a pure append.
 */
function resolveAppendOnlyFile(base: string | null, target: string | null, feature: string | null): string | null {
  // A brand-new file added on both sides (no common ancestor) is an add/add conflict,
  // not an append — skip (we can't know a safe order).
  if (base === null || target === null || feature === null) return null;
  if (!target.startsWith(base) || !feature.startsWith(base)) return null;
  const targetTail = target.slice(base.length);
  const featureTail = feature.slice(base.length);
  // Both unchanged would not have conflicted; if exactly one changed, git merges it
  // cleanly without a conflict — so by the time we're here both tails are non-empty.
  // Guard `base` ending without a trailing newline so the concatenation doesn't glue
  // the base's last line onto the first appended line.
  const joiner = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  return base + joiner + targetTail + (targetTail.endsWith("\n") || targetTail === "" ? "" : "\n") + featureTail;
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
): Promise<{ commitSha: string; resolvedFiles: string[] } | null> {
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

  // Start from the target tree (it has every other file at its current state) and
  // overwrite just the resolved blobs via `git update-index`/`read-tree` in a temp index.
  // Using a scratch index file keeps the real index untouched (safe alongside a checkout).
  const scratchIndex = join(repoPath, ".git", `append-merge-index-${targetSha.slice(0, 8)}`);
  const indexEnvGit = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: scratchIndex } },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
          else resolve(stdout.toString());
        },
      );
    });

  try {
    await indexEnvGit(["read-tree", targetSha]);
    for (const { path, content } of resolutions) {
      const blobSha = await hashObjectFromStdin(repoPath, content);
      await indexEnvGit(["update-index", "--cacheinfo", `100644,${blobSha},${path}`]);
    }
    const mergedTree = (await indexEnvGit(["write-tree"])).trim();
    const commitSha = (await execGit(
      ["commit-tree", mergedTree, "-p", targetSha, "-p", featureSha, "-m", `Merge branch '${featureBranch}' (append-only auto-resolve)`],
      repoPath,
    )).trim();
    return { commitSha, resolvedFiles: resolutions.map((r) => r.path) };
  } catch {
    return null;
  } finally {
    await rm(scratchIndex, { force: true }).catch(() => undefined);
  }
}

/**
 * Read-only check (#763): would merging `featureBranch` into `targetBranch` conflict
 * ONLY on pure-append hot files? Returns the list of pure-append conflicting files when
 * EVERY conflicting file is a pure append (so {@link mergeBranch} with
 * `autoResolveAppendConflicts` would land it by concatenation), or null when there are
 * no conflicts or any conflict is a non-append edit. Never mutates the working tree —
 * safe for the merge pre-flight to call to route an append-cluster member to a normal
 * merge instead of fix-and-merge.
 */
export async function detectAppendOnlyResolvableConflicts(
  repoPath: string,
  featureBranch: string,
  targetBranch: string,
): Promise<string[] | null> {
  const { hasConflicts, conflictingFiles } = await detectConflictsByBranch(repoPath, featureBranch, targetBranch);
  if (!hasConflicts || conflictingFiles.length === 0) return null;

  let targetSha: string;
  let featureSha: string;
  let baseSha: string;
  try {
    targetSha = (await execGit(["rev-parse", targetBranch], repoPath)).trim();
    featureSha = (await execGit(["rev-parse", featureBranch], repoPath)).trim();
    baseSha = (await execGit(["merge-base", targetBranch, featureBranch], repoPath)).trim();
  } catch {
    return null;
  }
  if (!baseSha) return null;

  for (const path of conflictingFiles) {
    const [base, target, feature] = await Promise.all([
      readBlobAtRef(repoPath, baseSha, path),
      readBlobAtRef(repoPath, targetSha, path),
      readBlobAtRef(repoPath, featureSha, path),
    ]);
    if (resolveAppendOnlyFile(base, target, feature) === null) return null;
  }
  return conflictingFiles;
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
  const { treeSha, conflictingFiles, mergeTreeHadConflictExit } = await new Promise<{
    treeSha: string;
    conflictingFiles: string[];
    mergeTreeHadConflictExit: boolean;
  }>((resolve, reject) => {
    execFile(
      "git",
      ["merge-tree", "--write-tree", targetBranch, featureBranch],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = stdout.toString().trim();
        // git merge-tree exits 1 for conflicts (expected, output still valid).
        // A real failure (exit 128+) produces no usable output — propagate the
        // git error instead of a misleading "no output" message.
        if (err && !output) {
          reject(new Error(`git merge-tree --write-tree failed: ${stderr?.toString().trim() || err.message}`));
          return;
        }
        const lines = output.split("\n").filter(Boolean);
        const treeSha = lines[0]?.trim() ?? "";
        if (!treeSha) {
          reject(new Error(`git merge-tree produced no output${stderr?.toString().trim() ? `: ${stderr.toString().trim()}` : ""}`));
          return;
        }
        // Stage 1/2/3 entries indicate conflicting files: "<mode> <sha> <stage>\t<file>"
        const seen = new Set<string>();
        for (const line of lines.slice(1)) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        // Track whether git itself reported a conflict exit (belt-and-suspenders).
        const mergeTreeHadConflictExit = err !== null && (err as NodeJS.ErrnoException & { code?: number }).code === 1;
        resolve({ treeSha, conflictingFiles: [...seen], mergeTreeHadConflictExit });
      },
    );
  });

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
    );
    if (resolved) {
      await execGit(["update-ref", `refs/heads/${targetBranch}`, resolved.commitSha], repoPath);
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

  // Atomically advance the target branch ref.
  await execGit(["update-ref", `refs/heads/${targetBranch}`, newCommitSha], repoPath);

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
 * This wrapper self-heals that state: after the reset it asks git for any tracked
 * paths deleted from the working tree (`diff --diff-filter=D` against HEAD) and
 * restores just those from the index, leaving any legitimate post-reset state
 * intact. If the reset itself throws, we still attempt the restore so the caller
 * never observes a checkout with tracked files missing — then re-raise so the
 * merge is reported as failed rather than silently half-applied.
 */
async function syncWorkingTreeHard(repoPath: string, commitSha: string): Promise<void> {
  try {
    await execGit(["reset", "--hard", commitSha], repoPath);
  } catch (err) {
    await restoreDeletedTrackedFiles(repoPath);
    throw err;
  }
  await restoreDeletedTrackedFiles(repoPath);
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

// --- Drizzle migration auto-renumber -------------------------------------

/** Path (relative to repo root) of the drizzle migrations directory. */
const DRIZZLE_DIR = "packages/shared/drizzle";
/** Path (relative to repo root) of the drizzle migration journal. */
const JOURNAL_PATH = `${DRIZZLE_DIR}/meta/_journal.json`;
/** Matches a drizzle migration filename: NNNN_some_name.sql */
const MIGRATION_RE = /^(\d{4})_(.+)\.sql$/;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface MigrationJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface RenumberResult {
  /** True when at least one migration was renamed and a commit was made. */
  renumbered: boolean;
  /** The renames performed, e.g. [{ from: "0058_foo.sql", to: "0059_foo.sql" }]. */
  renames: { from: string; to: string }[];
}

const migrationNumber = (file: string): number =>
  parseInt(file.match(MIGRATION_RE)![1], 10);
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** Split git porcelain output into trimmed, non-empty lines (handles Windows CRLF). */
function splitGitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
}

/** Read and JSON-parse the migration journal at a git ref (run in `cwd`). Returns null if absent. */
async function readJournalAtRef(cwd: string, ref: string): Promise<MigrationJournal | null> {
  try {
    const raw = await execGit(["show", `${ref}:${JOURNAL_PATH}`], cwd);
    return JSON.parse(raw) as MigrationJournal;
  } catch {
    return null;
  }
}

/** List migration .sql basenames present at a git ref (run in `cwd`). */
async function listMigrationsAtRef(cwd: string, ref: string): Promise<string[]> {
  try {
    const out = await execGit(["ls-tree", "--name-only", `${ref}:${DRIZZLE_DIR}`], cwd);
    return splitGitLines(out).filter((f) => MIGRATION_RE.test(f));
  } catch {
    return [];
  }
}

/**
 * Detect Drizzle migration-number collisions between a feature branch's worktree
 * and the target (base) branch, and rewrite the feature branch's migrations to the
 * next free numbers so the subsequent merge is conflict-free.
 *
 * Multiple feature branches independently pick the same "next" migration number
 * (e.g. all create `0058_*.sql`). The first merges cleanly; later ones collide —
 * silently (same number, different slug → git merges both files, corrupting drizzle
 * ordering) or loudly (`_journal.json` text conflict). This rewrites the *incoming*
 * branch before the merge so both failure modes are avoided.
 *
 * Operates IN THE WORKTREE (`worktreePath`, on the feature branch). It:
 *   - reads the base branch's migration state from `repoPath` (the MAIN checkout),
 *     which is the authoritative, settled ref — the worktree's own base ref may be
 *     stale relative to migrations another branch just merged;
 *   - renames each colliding `NNNN_*.sql` to the next free number;
 *   - rebuilds `_journal.json` as `[...baseEntries, ...renumberedFeatureEntries]`
 *     so the feature journal shares the base's exact prefix (no journal conflict);
 *   - commits ONLY the migration paths on the feature branch and syncs the branch ref.
 *
 * No-op (`renumbered:false`) when the feature branch added no migrations. Idempotent:
 * a second call after a successful renumber finds no collisions and does nothing.
 *
 * Drizzle applies migrations in journal-array / `idx` order (the live journal's `when`
 * timestamps are NOT monotonic), so correctness rests on `idx` + array position, with
 * `when` kept monotonic only as belt-and-suspenders.
 */
export async function autoRenumberMigrations(
  worktreePath: string,
  repoPath: string,
  baseBranch: string,
): Promise<RenumberResult> {
  const noop: RenumberResult = { renumbered: false, renames: [] };

  // Files the feature branch ADDED relative to base (--diff-filter=A), scoped to drizzle.
  let addedMigrations: string[];
  try {
    const out = await execGit(
      ["diff", "--name-only", "--diff-filter=A", `${baseBranch}...HEAD`],
      worktreePath,
    );
    addedMigrations = splitGitLines(out)
      .filter((p) => p.startsWith(`${DRIZZLE_DIR}/`))
      .map((p) => p.slice(p.lastIndexOf("/") + 1))
      .filter((f) => MIGRATION_RE.test(f));
  } catch {
    return noop;
  }
  if (addedMigrations.length === 0) return noop;

  // Base ground truth from the MAIN checkout (settled under the merge lock).
  const baseFiles = await listMigrationsAtRef(repoPath, baseBranch);
  const baseJournal = await readJournalAtRef(repoPath, baseBranch);
  const featJournal = await readJournalAtRef(worktreePath, "HEAD");
  if (!baseJournal || !featJournal) return noop;

  const baseFileSet = new Set(baseFiles);
  const baseNums = new Set(baseFiles.map(migrationNumber));
  const baseTags = new Set(baseJournal.entries.map((e) => e.tag));

  // A feature migration is "new" if its filename isn't already on base.
  const featNew = addedMigrations
    .filter((f) => !baseFileSet.has(f))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b));
  if (featNew.length === 0) return noop;

  // Collision = number or tag already used on base.
  const collides = (f: string): boolean =>
    baseNums.has(migrationNumber(f)) || baseTags.has(f.replace(/\.sql$/, ""));
  const hasCollision = featNew.some(collides);

  // If nothing collides AND the feature's journal already contains every base entry
  // (i.e. the feature is up to date with base), the merge is genuinely clean — leave
  // the branch untouched. Otherwise base advanced past the feature and the appended
  // journal entries would textually conflict, so we rebuild even without a collision.
  const featTags = new Set(featJournal.entries.map((e) => e.tag));
  const baseAdvanced = baseJournal.entries.some((be) => !featTags.has(be.tag));
  if (!hasCollision && !baseAdvanced) return noop;

  // Assign target numbers. If ANY feature migration collides, renumber ALL of them to
  // a contiguous block starting above the base's highest number — preserving their
  // relative order. Renumbering only the individually-colliding ones could push one
  // past another feature migration and invert their apply order. (A feature that adds
  // a non-colliding migration but where base merely advanced its journal keeps its
  // numbers; only the journal is rebuilt.)
  const baseMax = Math.max(-1, ...baseFiles.map(migrationNumber));
  const renameMap = new Map<string, string>(); // oldFile -> newFile
  if (hasCollision) {
    let target = baseMax + 1;
    for (const f of featNew) {
      const newName = f.replace(MIGRATION_RE, (_m, _n, rest) => `${pad4(target)}_${rest}.sql`);
      renameMap.set(f, newName);
      target++;
    }
  } else {
    for (const f of featNew) renameMap.set(f, f);
  }

  const renames = [...renameMap.entries()]
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }));

  // If no file actually moves and base didn't advance, nothing to do.
  if (renames.length === 0 && !baseAdvanced) return noop;

  // Perform file renames. Move in DESCENDING target order so a 0058->0059 rename never
  // clobbers an existing 0059 that is itself about to move to 0060.
  const migDir = join(worktreePath, ...DRIZZLE_DIR.split("/"));
  const ordered = renames.slice().sort((a, b) => migrationNumber(b.to) - migrationNumber(a.to));
  for (const { from, to } of ordered) {
    await rename(join(migDir, from), join(migDir, to));
  }

  // Rebuild the journal: base entries verbatim, then feature-added entries renumbered.
  // Sharing base's exact prefix means `_journal.json` merges without conflict.
  const featTagToFile = new Map<string, string>(featNew.map((f) => [f.replace(/\.sql$/, ""), f]));
  const featAddedEntries = featJournal.entries
    .filter((e) => featTagToFile.has(e.tag))
    .sort((a, b) => migrationNumber(`${a.tag}.sql`) - migrationNumber(`${b.tag}.sql`));

  let nextIdx = baseJournal.entries.length === 0 ? 0 : Math.max(...baseJournal.entries.map((e) => e.idx)) + 1;
  let nextWhen = Math.max(0, ...baseJournal.entries.map((e) => e.when), ...featJournal.entries.map((e) => e.when));
  const rebuiltFeatureEntries: JournalEntry[] = featAddedEntries.map((e) => {
    const oldFile = featTagToFile.get(e.tag)!;
    const newName = renameMap.get(oldFile) ?? oldFile;
    nextWhen += 1;
    return {
      idx: nextIdx++,
      version: e.version,
      when: nextWhen,
      tag: newName.replace(/\.sql$/, ""),
      breakpoints: e.breakpoints,
    };
  });

  const rebuiltJournal: MigrationJournal = {
    version: baseJournal.version,
    dialect: baseJournal.dialect,
    entries: [...baseJournal.entries, ...rebuiltFeatureEntries],
  };
  // Match drizzle's serialization: 2-space indent, single trailing newline.
  await writeFile(
    join(worktreePath, ...JOURNAL_PATH.split("/")),
    JSON.stringify(rebuiltJournal, null, 2) + "\n",
  );

  // Stage the migration dir (adds, deletes, and renames) in one shot.
  await execGit(["add", "-A", "--", DRIZZLE_DIR], worktreePath);

  // Commit ONLY the migration-related paths so we never sweep in the agent's
  // unrelated uncommitted work. Only include the test helper if it exists here.
  const commitPaths = [DRIZZLE_DIR];

  // The server test helper now reads from the drizzle journal dynamically,
  // so no manual sync of a hardcoded MIGRATION_FILES list is needed.
  // The journal itself was rewritten above and is already staged.

  const renameSummary = renames.map((r) => `${r.from}→${r.to}`).join(", ");
  await execGit(
    [
      "commit",
      "-m",
      `chore(migrations): auto-renumber to resolve conflict on merge (${renameSummary || "rejournal"})`,
      "--",
      ...commitPaths,
    ],
    worktreePath,
  );

  // Bring the base branch into the feature branch so the feature's history descends
  // from the current base. This is what makes the eventual merge-to-base conflict-free:
  // the 3-way merge's ancestor becomes the just-merged base, so `_journal.json` and the
  // (now uniquely-numbered) SQL files no longer overlap. The merge conflicts on the
  // journal (both sides edited the array tail) — we resolve it by re-writing our rebuilt
  // journal, which already incorporates base's entries as its prefix.
  const baseRef = await resolveLocalBaseRef(worktreePath, baseBranch);
  try {
    await execGit(["merge", "--no-ff", "--no-commit", "-m", `Merge ${baseBranch} for migration renumber`, baseRef], worktreePath);
  } catch {
    // Conflicts expected on the migration files (both sides edited the journal tail).
    // We only own the migration paths — if anything ELSE conflicted, abort and leave the
    // branch as it was so the normal merge conflict-resolution flow can handle it.
    const unmerged = splitGitLines(await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath).catch(() => ""));
    const nonMigration = unmerged.filter((p) => !p.startsWith(`${DRIZZLE_DIR}/`));
    if (nonMigration.length > 0) {
      await execGit(["merge", "--abort"], worktreePath).catch(() => { /* best effort */ });
      throw new Error(
        `migration renumber aborted: base merge has non-migration conflicts (${nonMigration.join(", ")})`,
      );
    }
  }
  // Re-assert the rebuilt journal as the resolution (the merge may have left conflict
  // markers in it), restage the migration dir, and commit the merge.
  await writeFile(
    join(worktreePath, ...JOURNAL_PATH.split("/")),
    JSON.stringify(rebuiltJournal, null, 2) + "\n",
  );
  await execGit(["add", "-A", "--", DRIZZLE_DIR], worktreePath);
  try {
    await execGit(["commit", "--no-edit"], worktreePath);
  } catch { /* nothing to commit — base was already an ancestor */ }

  // Make sure the branch ref points at the new commit (handles detached-HEAD edge).
  const branch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).trim();
  if (branch && branch !== "HEAD") await syncBranchToHead(worktreePath, branch);

  return { renumbered: renames.length > 0, renames };
}

/** Resolve the base branch to a local-or-remote ref that exists from this worktree. */
async function resolveLocalBaseRef(worktreePath: string, baseBranch: string): Promise<string> {
  try {
    await execGit(["rev-parse", "--verify", baseBranch], worktreePath);
    return baseBranch;
  } catch {
    return `origin/${baseBranch}`;
  }
}

/**
 * Ensure a worktree's HEAD is attached to the expected branch.
 * After a failed rebase or other operation, the worktree can end up in
 * detached HEAD state — commits go nowhere and merges become no-ops.
 * This reattaches HEAD to the branch, preserving any dangling commits.
 */
export async function ensureOnBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const current = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const currentBranch = current.trim();

  if (currentBranch !== branch) {
    // Worktree is detached or on wrong branch — get current HEAD commit
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();

    // Force-update the branch ref to point at current HEAD (captures dangling commits)
    await execGit(["branch", "-f", branch, headCommit], worktreePath);

    // Reattach HEAD to the branch
    await execGit(["checkout", branch], worktreePath);
  }
}

/**
 * Sync the branch ref to match the worktree's HEAD.
 * Before merging, call this to ensure the branch pointer reflects
 * any commits the agent made (even if they were in detached HEAD).
 */
export async function syncBranchToHead(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  try {
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();
    const branchCommit = (await execGit(["rev-parse", branch], worktreePath)).trim();

    if (headCommit !== branchCommit) {
      // HEAD is ahead of the branch (or detached) — update branch to match
      await execGit(["branch", "-f", branch, headCommit], worktreePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get the current branch name of a repo. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return output.trim();
}

/** Get the current HEAD commit SHA (full 40-character hash). */
export async function getHeadCommitSha(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "HEAD"], repoPath);
  return output.trim();
}

/** Get diff of working tree changes against HEAD (for direct workspaces), including untracked files. */
export async function getWorkingTreeDiff(workdirPath: string): Promise<string> {
  const tracked = await execGit(["diff", "HEAD"], workdirPath);
  const untracked = await getUntrackedDiffEntries(workdirPath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/**
 * Commit any uncommitted changes in a worktree so a rebase/merge can run on a clean tree.
 * Agents routinely leave small artifacts behind (a modified .gitignore, a generated
 * CLAUDE.local.md/HANDOFF.md) without committing them; a rebase refuses to run on a dirty
 * tree, so the auto-merge skips the workspace forever (an infinite "rebase conflict" loop
 * with an empty file list). Committing the leftovers preserves the work rather than
 * discarding or stalling it. Returns the number of files committed (0 if the tree was clean).
 */
export async function commitLeftoverChanges(worktreePath: string): Promise<number> {
  try {
    const statusOutput = await execGit(["status", "--porcelain"], worktreePath);
    const changedFiles = statusOutput.trim().split("\n").filter(Boolean);
    if (changedFiles.length === 0) return 0;
    await execGit(["add", "-A"], worktreePath);
    await execGit([
      "-c", "user.name=agentic-kanban",
      "-c", "user.email=board@agentic-kanban.local",
      "commit", "-m", "chore: commit leftover workspace changes before merge",
    ], worktreePath);
    console.log(`[git] committed ${changedFiles.length} leftover change(s) in ${worktreePath} before rebase`);
    return changedFiles.length;
  } catch (err) {
    console.log(`[git] failed to commit leftover changes in ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Fetch the latest base branch and rebase the current workspace branch onto it.
 * Returns the diff ref to use for review (e.g., "origin/main" or "main").
 * On conflict, aborts the rebase and returns success=false with conflicting file names.
 */
export async function prepareForReview(
  worktreePath: string,
  baseBranch: string,
): Promise<{ diffRef: string; success: boolean; conflictingFiles?: string[]; error?: string; uncommittedChanges?: string[] }> {
  // Abort any in-progress rebase from a prior failed attempt (idempotent retry safety)
  try {
    await execGit(["rebase", "--abort"], worktreePath);
    console.log(`[git] aborted stale in-progress rebase in ${worktreePath}`);
  } catch {
    // No rebase in progress — expected
  }

  // Commit any uncommitted changes so the rebase runs on a clean tree. Bailing here (the old
  // behavior) made the auto-merge skip a workspace forever whenever an agent left a stray
  // .gitignore edit / CLAUDE.local.md behind — an infinite "rebase conflict" loop.
  await commitLeftoverChanges(worktreePath);

  // Try to fetch from origin (best effort — no remote is fine)
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch {
    // No remote configured — use local branches only
  }

  // Rebase onto the LOCAL base branch — that's where the board merges into
  // (mergeBranch targets the local default branch, never origin). In this
  // local-first app (manual merge only, no push), local master can be many
  // commits ahead of a stale origin/master; rebasing onto origin would replay
  // all local-only history and conflict spuriously. Fall back to the remote ref
  // only if the local base branch doesn't exist.
  let rebaseSource: string;
  try {
    await execGit(["rev-parse", "--verify", baseBranch], worktreePath);
    rebaseSource = baseBranch;
  } catch {
    rebaseSource = `origin/${baseBranch}`;
  }

  // Rebase the workspace branch onto the base branch
  try {
    await execGit(["rebase", rebaseSource], worktreePath);
  } catch (err) {
    // Rebase conflict — collect conflicting files, then abort to leave worktree clean
    let conflictingFiles: string[] | undefined;
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
    } catch { /* best effort */ }
    try {
      await execGit(["rebase", "--abort"], worktreePath);
    } catch { /* best effort */ }
    return { diffRef: rebaseSource, success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
  }

  return { diffRef: rebaseSource, success: true };
}

/** Check if a directory is a valid git working tree (has .git file/dir). */
function isGitWorkingTree(dir: string): boolean {
  try { return existsSync(join(dir, ".git")); } catch { return false; }
}

/** Get lightweight diff stats using --shortstat (no full diff transfer). Includes untracked files. */
export async function getDiffShortstat(
  worktreePath: string,
  baseBranch: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  if (!isGitWorkingTree(worktreePath)) return { filesChanged: 0, insertions: 0, deletions: 0 };
  try {
    // For direct workspaces (baseBranch="HEAD"), compare working tree against HEAD
    // For feature branches, use three-dot to show changes since branching
    const diffArgs = baseBranch === "HEAD"
      ? ["diff", "--shortstat", "HEAD"]
      : ["diff", "--shortstat", `${baseBranch}...HEAD`];
    const output = await execGit(diffArgs, worktreePath);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    if (output.trim()) {
      const filesMatch = output.match(/(\d+) files? changed/);
      if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

      const insertionsMatch = output.match(/(\d+) insertion/);
      if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

      const deletionsMatch = output.match(/(\d+) deletion/);
      if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);
    }

    const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    if (untracked.trim()) {
      const untrackedList = untracked.trim().split("\n").filter(Boolean);
      filesChanged += untrackedList.length;
      for (const f of untrackedList) {
        try {
          const content = await readFile(join(worktreePath, ...f.split("/")), "utf-8");
          const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
          insertions += lineCount;
        } catch { /* binary or unreadable */ }
      }
    }

    return { filesChanged, insertions, deletions };
  } catch (err) {
    console.error(`[git] diff --shortstat failed in ${worktreePath}:`, err instanceof Error ? err.message : String(err));
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

/**
 * List the changed file paths in a worktree (tracked changes vs baseBranch plus
 * untracked files). Used to evaluate `diff_touches` / `diff_clean` workflow edge
 * conditions. Returns [] when the dir is not a git working tree.
 */
export async function getChangedFileNames(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  if (!isGitWorkingTree(worktreePath)) return [];
  try {
    const diffArgs = baseBranch === "HEAD"
      ? ["diff", "--name-only", "HEAD"]
      : ["diff", "--name-only", `${baseBranch}...HEAD`];
    const tracked = await execGit(diffArgs, worktreePath);
    const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    const files = new Set<string>();
    for (const line of `${tracked}\n${untracked}`.split("\n")) {
      const f = line.trim();
      if (f) files.add(f);
    }
    return [...files];
  } catch {
    return [];
  }
}

/** Get the number of commits on HEAD that are not reachable from baseBranch. */
export async function getCommitCountAhead(
  worktreePath: string,
  baseBranch: string,
): Promise<number | null> {
  if (!isGitWorkingTree(worktreePath)) return null;
  try {
    const output = await execGit(["rev-list", "--count", `${baseBranch}..HEAD`], worktreePath);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const count = Number.parseInt(trimmed, 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

/** Get the latest commit SHA (short) and message on the current branch. Returns null when no commits exist. */
export async function getLatestCommit(
  worktreePath: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const output = await execGit(["log", "-1", "--format=%h\t%s"], worktreePath);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) return null;
    return { sha: trimmed.slice(0, tabIdx), message: trimmed.slice(tabIdx + 1) };
  } catch {
    return null;
  }
}

/**
 * Detect merge conflicts between the current branch and the base branch.
 * Uses git merge-tree (read-only, no working tree changes) — safe for concurrent calls.
 */
export async function detectConflicts(
  worktreePath: string,
  baseBranch: string,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  return new Promise((resolve, reject) => {
    // merge-tree exits 0 for clean merge, 1 for conflicts.
    // Stdout: tree SHA on line 1, then conflict entries (mode sha stage\tfile) for conflicting files.
    execFile(
      "git",
      ["merge-tree", "--write-tree", "--no-messages", "HEAD", baseBranch],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = stdout.toString().trim();
        // A real failure (exit 128+) produces no usable output — reject so callers
        // don't silently treat it as "no conflicts". Exit 1 (conflicts) is fine:
        // output still has the tree SHA + conflict entries.
        if (err && !output) {
          reject(new Error(`git merge-tree --write-tree (detectConflicts) failed: ${stderr?.toString().trim() || err.message}`));
          return;
        }
        const lines = output.split("\n").slice(1).filter(Boolean);
        // Lines with stage 1/2/3 indicate conflicting files: "<mode> <sha> <stage>\t<file>"
        const seen = new Set<string>();
        for (const line of lines) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        const conflictingFiles = [...seen];
        resolve({ hasConflicts: conflictingFiles.length > 0, conflictingFiles });
      },
    );
  });
}

/**
 * Rebase the current branch onto the latest base branch.
 * On conflict, returns conflicting files and leaves rebase in-progress for resolution.
 */
export async function rebaseOntoBase(
  worktreePath: string,
  baseBranch: string,
  branch?: string,
  options: { preferLocalBase?: boolean } = {},
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  // A dirty worktree makes `git rebase` fail with an empty conflict list ("rebase conflict: "),
  // which the merge queue then skips forever. Commit any leftover changes first. (#nnn)
  await commitLeftoverChanges(worktreePath);

  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  if (!options.preferLocalBase) {
    try {
      await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
      source = `origin/${baseBranch}`;
    } catch { /* use local */ }
  }

  try {
    await execGit(["rebase", source], worktreePath);
    // Rebase can leave worktree in detached HEAD — reattach
    if (branch) {
      await ensureOnBranch(worktreePath, branch);
    }
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

/** Abort an in-progress rebase. */
export async function abortRebase(worktreePath: string): Promise<void> {
  await execGit(["rebase", "--abort"], worktreePath);
}

/** Abort an in-progress merge. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execGit(["merge", "--abort"], worktreePath);
}

/**
 * Return a list of staged or unstaged changes to tracked files in repoPath.
 * Untracked (new) files are excluded because they do not block `git merge`.
 * An empty array means the working tree is clean and safe to merge into.
 */
export async function getUncommittedTrackedChanges(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(["status", "--porcelain", "--untracked-files=no"], repoPath);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** List files changed between two refs (uses `git diff --name-only A..B`). */
export async function getChangedFilesBetween(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  try {
    const output = await execGit(["diff", "--name-only", `${fromRef}..${toRef}`], repoPath);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** List commit summaries between two refs, newest first. */
export async function getCommitSummariesBetween(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<Array<{ sha: string; message: string }>> {
  try {
    const output = await execGit(["log", "--format=%h%x09%s", `${fromRef}..${toRef}`], repoPath);
    return output
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tabIdx = line.indexOf("\t");
        return tabIdx === -1
          ? { sha: line, message: "" }
          : { sha: line.slice(0, tabIdx), message: line.slice(tabIdx + 1) };
      });
  } catch {
    return [];
  }
}

/** A single commit's metadata as surfaced for a merged issue. */
export interface CommitInfo {
  /** Full 40-char SHA. */
  sha: string;
  /** Abbreviated (short) SHA. */
  shortSha: string;
  /** Commit subject line. */
  message: string;
  /** Author name. */
  author: string;
  /** Author date as an ISO-8601 string. */
  date: string;
}

/**
 * List the commits a branch contributed relative to `baseRef`, newest first.
 *
 * Resolves to the commits reachable from `branch` but NOT from `baseRef`
 * (`git log baseRef..branch`), excluding merge commits — i.e. the actual work
 * that landed for a merged workspace. `baseRef` is typically the workspace's
 * recorded `baseCommitSha` (the commit the branch was cut from); using that
 * exact point gives the precise set of commits this branch introduced, even
 * after the branch has been merged into the default branch.
 *
 * Returns [] when the refs cannot be resolved (deleted branch, unknown SHA) so
 * callers can treat "no commits" and "branch gone" uniformly.
 */
export async function getCommitsForBranch(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<CommitInfo[]> {
  try {
    // %H full sha, %h short sha, %an author, %aI author ISO date, %s subject.
    // Unit-separator (\x1f) between fields, record-separator (\x1e) between commits —
    // both safe against tabs/newlines in commit messages.
    const output = await execGit(
      ["log", "--no-merges", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e", `${baseRef}..${branch}`],
      repoPath,
    );
    return output
      .split("\x1e")
      .map((rec) => rec.replace(/^\s+/, ""))
      .filter(Boolean)
      .map((rec) => {
        const [sha = "", shortSha = "", author = "", date = "", message = ""] = rec.split("\x1f");
        return { sha, shortSha, author, date, message };
      })
      .filter((c) => c.sha);
  } catch {
    return [];
  }
}

/** Stage and commit specific paths in repoPath. Returns true when a commit was created. */
export async function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
): Promise<boolean> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return false;
  await execGit(["add", "-A", "--", ...unique], repoPath);
  try {
    await execGit(["diff", "--cached", "--quiet", "--", ...unique], repoPath);
    return false;
  } catch {
    await execGit(["commit", "-m", message, "--", ...unique], repoPath);
    return true;
  }
}

/** Resolve a ref to its commit SHA (e.g. "HEAD"). */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return (await execGit(["rev-parse", ref], repoPath)).trim();
}

/** Return true when ancestorRef is reachable from descendantRef. */
export async function isAncestor(
  repoPath: string,
  ancestorRef: string,
  descendantRef: string,
): Promise<boolean> {
  try {
    await execGit(["merge-base", "--is-ancestor", ancestorRef, descendantRef], repoPath);
    return true;
  } catch {
    return false;
  }
}

export type BranchTipAncestryResult =
  | { isAncestor: true; branchSha: string; baseSha: string }
  | { isAncestor: false; branchSha: string; baseSha: string }
  | { isAncestor: false; branchSha: null; reason: "branch-not-found" | "base-not-found" };

/**
 * Resolve whether a branch tip is already an ancestor of the base branch.
 *
 * Handles deleted-branch: when the branch ref is gone from the main repo but
 * a worktreeDir is provided, falls back to resolving HEAD from the worktree.
 * If the branch (or base) cannot be resolved at all, returns branchSha: null
 * with a reason — callers treat this as "needs further investigation" rather
 * than an error.
 */
export async function checkBranchTipIsAncestor(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreeDir?: string,
): Promise<BranchTipAncestryResult> {
  let branchSha: string;
  try {
    branchSha = await revParse(repoPath, branch);
  } catch {
    if (worktreeDir) {
      try {
        branchSha = await revParse(worktreeDir, "HEAD");
      } catch {
        return { isAncestor: false, branchSha: null, reason: "branch-not-found" };
      }
    } else {
      return { isAncestor: false, branchSha: null, reason: "branch-not-found" };
    }
  }

  let baseSha: string;
  try {
    baseSha = await revParse(repoPath, baseBranch);
  } catch {
    return { isAncestor: false, branchSha: null, reason: "base-not-found" };
  }

  const ancestor = await isAncestor(repoPath, branchSha, baseSha);
  return ancestor
    ? { isAncestor: true, branchSha, baseSha }
    : { isAncestor: false, branchSha, baseSha };
}

/**
 * Count commits reachable from branchSha that are NOT reachable from baseSha.
 * Returns 0 on any git error (safer to skip reconciliation than to wrongly act).
 */
export async function countUniqueCommits(repoPath: string, baseSha: string, branchSha: string): Promise<number> {
  try {
    const out = await execGit(["rev-list", "--count", `${baseSha}..${branchSha}`], repoPath);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Read-only conflict detection between two named branches, operating from the main repo.
 * Uses `git merge-tree --write-tree baseBranch featureBranch` — never touches the working tree.
 * Safe to call even when the feature branch has no worktree checked out.
 */
export async function detectConflictsByBranch(
  repoPath: string,
  featureBranch: string,
  baseBranch: string,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["merge-tree", "--write-tree", "--no-messages", baseBranch, featureBranch],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = stdout.toString().trim();
        if (err && !output) {
          reject(new Error(`git merge-tree (detectConflictsByBranch) failed: ${stderr?.toString().trim() || err.message}`));
          return;
        }
        const lines = output.split("\n").slice(1).filter(Boolean);
        const seen = new Set<string>();
        for (const line of lines) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        const conflictingFiles = [...seen];
        resolve({ hasConflicts: conflictingFiles.length > 0, conflictingFiles });
      },
    );
  });
}

/**
 * Count how many commits base has that featureBranch does not (the "behind" count).
 * Throws on git error so callers can treat the failure as a safety signal.
 */
export async function countBehindCommits(repoPath: string, featureBranch: string, baseBranch: string): Promise<number> {
  const out = await execGit(["rev-list", "--count", `${featureBranch}..${baseBranch}`], repoPath);
  return parseInt(out.trim(), 10) || 0;
}

/** Check if a rebase is in progress in the worktree. */
export async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
  try {
    const dir = (await execGit(["rev-parse", "--git-dir"], worktreePath)).trim();
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(worktreePath, dir, "rebase-merge")) || existsSync(pathJoin(worktreePath, dir, "rebase-apply"));
  } catch {
    return false;
  }
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
