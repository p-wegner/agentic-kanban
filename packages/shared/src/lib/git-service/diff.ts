import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit, isGitWorkingTree } from "./internal.js";
import { errorMessage } from "../error-message.js";

/** Generate unified diff entries for untracked files (not yet git-add'd). */
async function getUntrackedDiffEntries(workdirPath: string): Promise<string> {
  const untrackedFiles = await execGit(["ls-files", "--others", "--exclude-standard"], workdirPath);
  if (!untrackedFiles.trim()) return "";

  const entries: string[] = [];
  for (const f of untrackedFiles.trim().split("\n").filter(Boolean)) {
    try {
      const buf = await readFile(join(workdirPath, ...f.split("/")));
      // Binary detection (git's heuristic): a NUL byte in the first ~8000 bytes
      // ⇒ binary. utf-8 decode is lossy (not failing) on binary, so without this
      // check a binary file would be emitted with a garbage `+content` hunk.
      const sniffLen = Math.min(buf.length, 8000);
      let isBinary = false;
      for (let i = 0; i < sniffLen; i++) {
        if (buf[i] === 0) { isBinary = true; break; }
      }
      if (isBinary) {
        entries.push([
          `diff --git a/${f} b/${f}`,
          `new file mode 100644`,
          `Binary files /dev/null and b/${f} differ`,
        ].join("\n"));
        continue;
      }
      const content = buf.toString("utf-8");
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
/**
 * The git range for a workspace diff (#530).
 *
 * A DIRECT workspace commits straight to its branch, so there is no base to compare
 * against — callers pass the sentinel `"HEAD"` meaning "working tree vs HEAD". A
 * branch workspace uses three-dot, i.e. changes since it diverged.
 *
 * This existed inline in `getDiffShortstat` and `getChangedFileNames` but NOT in
 * `getDiff`, which built `${baseBranch}...HEAD` unconditionally — so for a direct
 * workspace it ran `git diff HEAD...HEAD`, which is empty by definition. The diff view
 * for a direct workspace therefore showed untracked files only, silently hiding every
 * modified tracked file. One helper so the sentinel cannot be honoured in two places
 * out of three again.
 */
export function diffRangeArgs(baseBranch: string): string[] {
  return baseBranch === "HEAD" ? ["HEAD"] : [`${baseBranch}...HEAD`];
}

/** The `"HEAD"` sentinel {@link diffRangeArgs} understands: working tree vs HEAD. */
export const DIRECT_WORKSPACE_DIFF_REF = "HEAD";

/**
 * Which ref a workspace's diff is taken against (#530).
 *
 * `ws.isDirect ? "HEAD" : (ws.baseBranch || defaultBranch)` was re-derived at nine call
 * sites. They agreed, but only by repetition — and the sentinel they all produce was
 * then honoured in only two of the three consumers (see {@link diffRangeArgs}), so
 * "everyone computes the same string" was never the same as "everyone means the same
 * thing by it". Producing it in one place is what makes the sentinel a contract.
 */
export function resolveDiffRef(
  workspace: { isDirect?: boolean | null; baseBranch?: string | null },
  defaultBranch: string | null | undefined,
): string | null {
  if (workspace.isDirect) return DIRECT_WORKSPACE_DIFF_REF;
  // Nullable on purpose. A branch workspace whose base is unknown has NO ref, and
  // several callers already test for that before spawning git; substituting a plausible
  // default here would silently diff against the wrong branch instead.
  return workspace.baseBranch || defaultBranch || null;
}

export async function getDiff(
  worktreePath: string,
  baseBranch: string = "main",
): Promise<string> {
  const tracked = await execGit(["diff", ...diffRangeArgs(baseBranch)], worktreePath);
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
    const diffArgs = ["diff", "--shortstat", ...diffRangeArgs(baseBranch)];
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
    console.error(`[git] diff --shortstat failed in ${worktreePath}:`, errorMessage(err));
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
    const diffArgs = ["diff", "--name-only", ...diffRangeArgs(baseBranch)];
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
