import { existsSync } from "node:fs";
import { mkdir, rm, stat, lstat, unlink, readdir, readFile } from "node:fs/promises";
import { join, dirname, basename, sep, resolve, parse, relative } from "node:path";
import { gitExec } from "../git-exec.js";
import { execGit } from "./internal.js";
import { parseIssueNumberFromBranch } from "../branch.js";
import { ensureOnBranch } from "./branch-attach.js";

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
 * Worktree directory prefixes eat deeply into the Windows MAX_PATH (260 char) budget:
 * `.worktrees/<full-branch-slug>` runs ~50 chars longer than the main checkout's own
 * `<repoName>` leaf, which is enough to tip a JVM/compiled-stack build's generated
 * paths (deep nested class files, backtick test names) over the limit even though the
 * identical commit builds green in the main checkout (#193). The branch itself keeps
 * its full descriptive slug (readability, `git branch -a`) — only the ON-DISK leaf is
 * shortened, and only when an issue number can be recovered from it, since that alone
 * identifies the work uniquely and is what every other identifier already anchors on.
 */
function shortenWorktreeLeaf(safeName: string): string {
  // #548: this file's boundary rules ARE the shared parser's — the sanitized-name problem
  // (`/` becomes `_`, itself a \w character, so a plain \b before "ak" never matches in
  // "feature_ak-1-…") is exactly why the shared one uses an explicit non-alnum boundary
  // rather than \b. A pure adoption: the leaf a given branch produces is unchanged, which
  // matters because worktree directories already exist on disk under these names.
  const issueNumber = parseIssueNumberFromBranch(safeName);
  return issueNumber === null ? safeName : `ak-${issueNumber}`;
}

/**
 * Sanitize one path segment for use as a directory name under `.worktrees`, or
 * return null when nothing safe is left (`""`, `.`, `..` would resolve to the
 * `.worktrees` dir itself or its parent).
 */
function safePathSegment(raw: string | undefined): string | null {
  const safe = (raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe === "" || safe === "." || safe === "..") return null;
  return safe;
}

/**
 * The directory a repo's worktrees live in: `<parent>/.worktrees/<repoDirName>`
 * (plus an optional extra namespace segment).
 *
 * The `<repoDirName>` segment is what makes a worktree path SELF-IDENTIFYING (#385).
 * `.worktrees` is shared by every repo under one parent directory (the guaranteed
 * layout for clone-from-URL repos), and the leaf carries only the issue number —
 * which is allocated PER PROJECT, so five sibling projects all have an issue #6.
 * Collision handling was correct (the second claimant got a `-2` suffix), but the
 * resulting path was ambiguous to a human or agent reading it, and it resolved in
 * the most misleading direction: un-suffixed `ak-6` belonged to whichever project
 * got there first, not to the project being inspected. That MEASURABLY induced the
 * same false catastrophic diagnosis ("the board dispatched the wrong project's
 * work") in three consecutive review rounds. Namespacing by the repo directory
 * makes collisions impossible instead of suffixed, and makes the path state its
 * own owner.
 *
 * This is the shape multi-repo siblings already used (`.worktrees/<repoDirName>/…`,
 * `workspace-repos.service.ts`); the single-repo path was the inconsistent one.
 * Siblings therefore no longer pass a namespace of their own — the default per-repo
 * segment is exactly what they were asking for.
 */
function worktreesDirFor(repoPath: string, extraNamespace?: string): string {
  const segments = [safePathSegment(basename(repoPath)), safePathSegment(extraNamespace)]
    .filter((s): s is string => s !== null);
  return join(dirname(repoPath), ".worktrees", ...segments);
}

/**
 * Create a git worktree for a branch, in `<parent>/.worktrees/<repoDirName>/<branch>`
 * — or `<parent>/.worktrees/<repoDirName>/<namespace>/<branch>` when
 * `opts.pathNamespace` is given (see {@link worktreesDirFor} for why the repo
 * directory is always part of the path).
 *
 * OLD-LAYOUT worktrees (`.worktrees/<branch>`, created before #385) keep working and
 * are NOT migrated — they age out as their workspaces merge/close:
 *  - reads use the DB's `workingDir`, which is authoritative;
 *  - this function's reuse path resolves through `git worktree list`, so an existing
 *    worktree on the branch is returned wherever it sits on disk;
 *  - every containment guard (`removeLeftoverWorktreeDirectory` here,
 *    `removeStaleWorktree`, `removeDirWithRetry`) tests "inside `.worktrees`", which a
 *    nested and a flat path both satisfy;
 *  - dev-port derivation reads only the LEAF, which is unchanged.
 * Consequence, accepted deliberately: during the transition `.worktrees/` holds a MIX
 * of both layouts, so the ambiguity survives for leaves that already exist.
 *
 * If the branch doesn't exist yet, it is created from the given baseBranch
 * (or HEAD if no baseBranch is specified).
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
  opts: {
    pathNamespace?: string;
    /**
     * Does a LIVE workspace still claim this directory? (#699)
     *
     * The leftover-cleanup below deletes an existing directory recursively, and both of
     * its guards ask GIT — which is exactly the authority that has already failed in the
     * case that matters. Callers that can answer from the DB should pass this; it is the
     * only source that knows a non-terminal workspace row names the path as its
     * `workingDir`. Optional, so the CLI/MCP call sites are unaffected.
     */
    isPathClaimed?: (worktreePath: string) => boolean;
  } = {},
): Promise<string> {
  // Read the registrations BEFORE pruning (#699). `pruneWorktrees` unregisters any
  // worktree git can no longer resolve — including a LIVE one whose `.git` file has
  // become unreadable — so capturing the list afterwards means the leftover-cleanup
  // guard below is evaluated against a list this function itself just emptied. That is
  // not hypothetical: it is reproducible, and it deleted two live worktrees on the dev
  // board (ak-697, ak-670) along with their uncommitted work.
  const registeredBeforePrune = await listWorktrees(repoPath).catch(() => []);

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

  // Sanitize branch name (and optional per-repo namespace) for directory use
  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safeName === "" || safeName === "." || safeName === "..") {
    // A branch name sanitizing down to '', '.', or '..' would make the worktree
    // leaf resolve to the .worktrees dir itself or its parent (the repo's parent
    // directory) — the leftover-cleanup rm -rf above would then recursively
    // delete that directory before git ever validates the branch name.
    throw new Error(
      `Refusing to create worktree for branch "${branch}": sanitized name "${safeName}" is not a safe directory leaf`,
    );
  }
  const worktreesDir = worktreesDirFor(repoPath, opts.pathNamespace);
  const dirLeaf = shortenWorktreeLeaf(safeName);
  let worktreePath = join(worktreesDir, dirLeaf);

  await mkdir(worktreesDir, { recursive: true });

  // If the target directory exists but is only a LEFTOVER (e.g. from a deleted
  // workspace), remove it so git worktree add doesn't fail with "already exists".
  // Never blind-delete, though: the directory may be a registered worktree of THIS
  // repo under a different branch (two branches can sanitize to the same directory
  // name), or a checkout belonging to ANOTHER repo — repos sharing a parent
  // directory share the same `.worktrees` root, so deleting it would destroy that
  // repo's live worktree (the multi-repo sibling collision bug). In those cases —
  // and when the removal fails (locked on Windows) — fall back to an alternative
  // path with a numeric suffix instead.
  try {
    await stat(worktreePath);
    let removed = false;
    // Claimed by git — under EITHER view. The pre-prune list is the load-bearing half:
    // a live worktree whose `.git` is damaged is absent from `existing` and present here.
    const claimedByThisRepo =
      isRegisteredWorktreePath(existing, worktreePath) ||
      isRegisteredWorktreePath(registeredBeforePrune, worktreePath);
    // Claimed by the DB — covers a registration lost in an EARLIER call, which the
    // pre-prune capture cannot see. A directory a live workspace is working in is never
    // a leftover, whatever git thinks.
    const claimedByLiveWorkspace = opts.isPathClaimed?.(worktreePath) ?? false;
    if (!claimedByThisRepo && !claimedByLiveWorkspace && !(await isForeignCheckout(repoPath, worktreePath))) {
      // Break junctions first (top-level + nested) so the recursive delete cannot
      // traverse a Windows junction into a main checkout's shared store (#518/#780).
      await breakJunctionsRecursively(worktreePath).catch(() => undefined);
      try {
        await rm(worktreePath, { recursive: true, force: true });
        removed = true;
      } catch {
        // Locked on Windows — fall through to the alternative path
      }
    }
    if (!removed) {
      for (let suffix = 2; suffix <= 10; suffix++) {
        const altPath = join(worktreesDir, `${dirLeaf}-${suffix}`);
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
  let branchExists = true;
  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    branchExists = false;
    const branchArgs = baseBranch ? ["branch", branch, baseBranch] : ["branch", branch];
    await execGit(branchArgs, repoPath);
  }

  // Reuse path (#781): the branch already existed but no live worktree did (a prior
  // failed/manual start, or a delete that dropped the worktree but not the branch).
  // If it carries NO unique commits beyond the resolved base — i.e. it was cut and
  // never built on — refresh it onto the up-to-date base so the next agent builds
  // against current master instead of the stale pre-merge base it was originally cut
  // from (the #778 symptom). If it has its own commits we leave it alone — never
  // discard real work; that branch is reused as-is.
  if (branchExists && baseBranch) {
    try {
      const ahead = (
        await execGit(["rev-list", "--count", `${baseBranch}..${branch}`], repoPath)
      ).trim();
      if (ahead === "0") {
        // Safe: branch is an ancestor of base (no unique commits). Hard-reset the
        // ref to base so reuse starts from the refreshed base.
        await execGit(["branch", "-f", branch, baseBranch], repoPath);
      }
    } catch {
      // Best-effort refresh — never block worktree creation on it.
    }
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
  // Break junctions first (top-level AND nested packages/<pkg>/node_modules) so
  // neither git nor the fs.rm fallback can traverse into the main checkout via a
  // Windows junction and delete the shared store (data-loss bugs #518 / #780).
  await breakJunctionsRecursively(worktreePath).catch(() => undefined);

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
 * Clone a single branch of a local repo into a fresh destination directory (#792).
 *
 * Unlike a worktree, this is a genuinely independent checkout: no junctioned
 * `node_modules`, no shared `.git`, no untracked artifacts — the same clean state a
 * teammate gets from `git clone`. Used by the cold-clone build check to catch
 * branches that build in the dependency-symlinked worktree but break on a fresh
 * clone (the #783 class). `--single-branch` keeps it cheap; `--no-hardlinks` is NOT
 * used so the local clone stays fast (object hardlinks are fine — they don't leak
 * the warm dependency store the way a worktree junction does).
 */
export async function cloneBranchTo(
  repoPath: string,
  branch: string,
  dest: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const { error, stderr } = await gitExec(
    ["clone", "--quiet", "--single-branch", "--branch", branch, repoPath, dest],
    { timeout: timeoutMs },
  );
  if (error) throw new Error(`git clone (branch ${branch}) failed: ${stderr || error.message}`);
}

/**
 * Recursively break every symlink/junction inside a directory WITHOUT recursing
 * INTO any link, so neither `git worktree remove` nor `fs.rm({ recursive })` can
 * traverse a Windows junction into the main checkout and delete the shared store
 * it points at (data-loss bugs #518 / #780).
 *
 * On a pnpm/yarn workspace with "Dependency Symlinks" enabled, the worktree gets
 * junctions at `node_modules` AND each nested `packages/<pkg>/node_modules` — all
 * pointing at the real shared store. Unlinking only the top level leaves the
 * nested junctions for the recursive delete to follow. So we descend into REAL
 * directories looking for deeper junctions, but for any entry that is itself a
 * link we only remove the LINK (never its target's contents).
 *
 * A junction reports `isSymbolicLink()` via lstat on Windows; we remove the link
 * with `unlink` (falls back to a non-recursive `rm` for platforms where a dir
 * symlink can't be unlinked), which deletes only the link, not the target.
 */
async function breakJunctionsRecursively(dirPath: string, depth = 0): Promise<void> {
  // Bound recursion defensively; legitimate junction nesting is shallow
  // (root + packages/<pkg>/node_modules).
  if (depth > 8) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    let st;
    try {
      st = await lstat(entryPath);
    } catch {
      // entry may have disappeared between readdir and lstat
      continue;
    }

    if (st.isSymbolicLink()) {
      // Remove ONLY the link itself — never recurse into / recursively delete its target.
      try {
        await unlink(entryPath);
      } catch {
        // Some platforms/dir-symlinks need rmdir-style removal of the link;
        // recursive:false removes the link node, NOT the target's contents.
        try {
          await rm(entryPath, { recursive: false, force: true });
        } catch {
          // best effort — leave it; the caller's safety guards still apply
        }
      }
      continue;
    }

    // Only descend into REAL directories to find deeper junctions
    // (e.g. worktree/packages/<pkg>/node_modules).
    if (st.isDirectory()) {
      await breakJunctionsRecursively(entryPath, depth + 1);
    }
  }
}

/**
 * True when `dirPath` is one of the repo's registered worktrees. Paths are compared
 * resolved + case-insensitively — a false positive only means we DON'T delete the
 * directory (the safe direction), so loose matching is deliberate.
 */
function isRegisteredWorktreePath(
  worktrees: { path: string }[],
  dirPath: string,
): boolean {
  const target = resolve(dirPath).toLowerCase();
  return worktrees.some((wt) => resolve(wt.path.replace(/\//g, sep)).toLowerCase() === target);
}

/**
 * True when the existing directory is some OTHER repo's checkout: a full clone
 * (`.git` directory) or a worktree whose `.git` file points outside this repo's
 * own `.git`. Repos sharing a parent directory place worktrees under the same
 * `.worktrees` root, so a same-named directory here can be another repo's LIVE
 * worktree — deleting it would destroy that repo's workspace. An unreadable or
 * unparseable `.git` entry is treated as foreign: never delete a directory we
 * cannot positively identify as this repo's own leftover.
 */
async function isForeignCheckout(repoPath: string, dirPath: string): Promise<boolean> {
  const gitEntry = join(dirPath, ".git");
  let entryStat;
  try {
    entryStat = await lstat(gitEntry);
  } catch {
    return false; // no .git — a plain leftover directory, not any repo's checkout
  }
  if (entryStat.isDirectory()) return true; // a full clone parked here — never one of our worktrees

  let gitdirTarget: string;
  try {
    const content = await readFile(gitEntry, "utf-8");
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match) return true;
    gitdirTarget = resolve(dirname(gitEntry), match[1]);
  } catch {
    return true;
  }

  const ownGitDir = resolve(repoPath, ".git");
  const rel = relative(ownGitDir, gitdirTarget);
  const isInsideOwnGit = rel === ""
    || (rel !== ".." && !rel.startsWith(`..${sep}`) && parse(rel).root === "");
  return !isInsideOwnGit;
}

/**
 * The single containment guard for recursive worktree deletion (#525).
 *
 * This predicate is the ONLY thing standing between a corrupt `workingDir` and a
 * recursive delete of a real repository, and it was written three ways — two
 * equivalent `relative()` implementations plus a much weaker one in the teardown
 * path that only asked whether the resolved path contained a `.worktrees` SEGMENT
 * anywhere, with no binding to the repo at all. That weaker form accepts e.g.
 * `/anything/.worktrees/../../home`-shaped input once resolved, and accepts a
 * worktree belonging to a DIFFERENT repository.
 *
 * `dir` must be strictly inside `<dirname(repoPath)>/.worktrees/`, must not be that
 * root itself, must not be the repo, and must not be a filesystem root.
 */
export function isInsideManagedWorktreesRoot(repoPath: string, dir: string): boolean {
  const repoResolved = resolve(repoPath);
  const targetResolved = resolve(dir);
  const worktreesRoot = resolve(dirname(repoPath), ".worktrees");
  const rel = relative(worktreesRoot, targetResolved);
  const strictlyInside = rel !== ""
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && parse(rel).root === "";
  if (!strictlyInside) return false;
  return targetResolved !== repoResolved && targetResolved !== parse(targetResolved).root;
}

async function removeLeftoverWorktreeDirectory(repoPath: string, worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;

  if (!isInsideManagedWorktreesRoot(repoPath, worktreePath)) {
    throw new Error(`Refusing to recursively remove unsafe worktree path: ${worktreePath}`);
  }

  // Break ALL symlinks/junctions (top-level + nested packages/<pkg>/node_modules)
  // before the recursive delete to prevent fs.rm from following them into the main
  // checkout's shared store (Windows junction data-loss bugs #518 / #780).
  await breakJunctionsRecursively(worktreePath);

  await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return !existsSync(worktreePath);
}
