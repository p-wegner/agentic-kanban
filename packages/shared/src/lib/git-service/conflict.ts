import { gitExec } from "../git-exec.js";
import { execGit } from "./internal.js";
import { readBlobAtRef, resolveAppendOnlyFile } from "./append-resolve.js";

/**
 * Detect merge conflicts between the current branch and the base branch.
 * Uses git merge-tree (read-only, no working tree changes) — safe for concurrent calls.
 */
export async function detectConflicts(
  worktreePath: string,
  baseBranch: string,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  // merge-tree exits 0 for clean merge, 1 for conflicts.
  // Stdout: tree SHA on line 1, then conflict entries (mode sha stage\tfile) for conflicting files.
  const { stdout, stderr, error } = await gitExec(
    ["merge-tree", "--write-tree", "--no-messages", "HEAD", baseBranch],
    { cwd: worktreePath },
  );
  const output = stdout.trim();
  // A real failure (exit 128+) produces no usable output — throw so callers
  // don't silently treat it as "no conflicts". Exit 1 (conflicts) is fine:
  // output still has the tree SHA + conflict entries.
  if (error && !output) {
    throw new Error(`git merge-tree --write-tree (detectConflicts) failed: ${stderr.trim() || error.message}`);
  }
  const lines = output.split("\n").slice(1).filter(Boolean);
  // Lines with stage 1/2/3 indicate conflicting files: "<mode> <sha> <stage>\t<file>"
  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
    if (m) seen.add(m[1].replace(/\r$/, ""));
  }
  const conflictingFiles = [...seen];
  return { hasConflicts: conflictingFiles.length > 0, conflictingFiles };
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
  const { stdout, stderr, error } = await gitExec(
    ["merge-tree", "--write-tree", "--no-messages", baseBranch, featureBranch],
    { cwd: repoPath },
  );
  const output = stdout.trim();
  if (error && !output) {
    throw new Error(`git merge-tree (detectConflictsByBranch) failed: ${stderr.trim() || error.message}`);
  }
  const lines = output.split("\n").slice(1).filter(Boolean);
  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
    if (m) seen.add(m[1].replace(/\r$/, ""));
  }
  const conflictingFiles = [...seen];
  return { hasConflicts: conflictingFiles.length > 0, conflictingFiles };
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
