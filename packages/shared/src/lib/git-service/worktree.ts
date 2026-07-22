import { existsSync } from "node:fs";
import { mkdir, rm, stat, lstat, unlink, readdir, readFile } from "node:fs/promises";
import { join, dirname, sep, resolve, parse, relative } from "node:path";
import { gitExec } from "../git-exec.js";
import { execGit } from "./internal.js";
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
 * Create a git worktree for a branch. The worktree is created in a
 * `.worktrees/<branch>` directory sibling to the repo root — or, when
 * `opts.pathNamespace` is given, in `.worktrees/<namespace>/<branch>`.
 *
 * The namespace exists for multi-repo workspaces: every repo of a workspace uses
 * the SAME branch name, and repos sharing a parent directory (the guaranteed
 * layout for clone-from-URL repos) share the same `.worktrees` root — without a
 * per-repo namespace the sibling repos' worktrees would collide on disk with the
 * leading repo's. Single-repo callers pass no namespace, so their path scheme
 * (`<parent>/.worktrees/<branch>`) is unchanged.
 *
 * If the branch doesn't exist yet, it is created from the given baseBranch
 * (or HEAD if no baseBranch is specified).
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
  opts: { pathNamespace?: string } = {},
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
  const safeNamespace = (opts.pathNamespace ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = safeNamespace && safeNamespace !== "." && safeNamespace !== ".."
    ? join(dirname(repoPath), ".worktrees", safeNamespace)
    : join(dirname(repoPath), ".worktrees");
  let worktreePath = join(worktreesDir, safeName);

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
    const claimedByThisRepo = isRegisteredWorktreePath(existing, worktreePath);
    if (!claimedByThisRepo && !(await isForeignCheckout(repoPath, worktreePath))) {
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

  // Break ALL symlinks/junctions (top-level + nested packages/<pkg>/node_modules)
  // before the recursive delete to prevent fs.rm from following them into the main
  // checkout's shared store (Windows junction data-loss bugs #518 / #780).
  await breakJunctionsRecursively(worktreePath);

  await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return !existsSync(worktreePath);
}
