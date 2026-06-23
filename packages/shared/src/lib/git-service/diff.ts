import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit, isGitWorkingTree } from "./internal.js";

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

/** Get diff of working tree changes against HEAD (for direct workspaces), including untracked files. */
export async function getWorkingTreeDiff(workdirPath: string): Promise<string> {
  const tracked = await execGit(["diff", "HEAD"], workdirPath);
  const untracked = await getUntrackedDiffEntries(workdirPath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
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
