import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { resolveDbLocation } from "../db-path.js";
import { gitExec } from "../git-exec.js";

/**
 * Worktree ownership (#1375).
 *
 * Two boards (stable + dev) register the SAME repo, and `git worktree list` shows every worktree
 * of it, so a board's orphan sweep used to treat the other board's fresh 0-commit worktree as
 * removable. On `worktree add` the creating board therefore writes its identity into the
 * worktree's git ADMIN dir (`<repo>/.git/worktrees/<name>/kanban-owner`) - not the working tree,
 * so nothing is committed or visible to the agent - and every sweep skips a worktree whose marker
 * names another board.
 */
export const WORKTREE_OWNER_FILE = "kanban-owner";

let cachedBoardId: string | null = null;

/** This board instance's identity: its database location (each board has its own DB). */
export function currentBoardInstanceId(): string {
  if (cachedBoardId) return cachedBoardId;
  let id: string;
  try {
    id = `db:${resolveDbLocation().url}`;
  } catch {
    id = `cwd:${process.cwd()}`;
  }
  cachedBoardId = id.replace(/\\/g, "/").toLowerCase();
  return cachedBoardId;
}

/** Test seam: forget the memoized identity. */
export function resetBoardInstanceIdCache(): void {
  cachedBoardId = null;
}

/** Resolve the worktree's admin dir from its `.git` file (`gitdir: ...`); null when unreadable. */
function adminDirFromGitFile(worktreePath: string): string | null {
  try {
    const content = readFileSync(join(worktreePath, ".git"), "utf-8");
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    return match ? resolve(worktreePath, match[1]) : null;
  } catch {
    return null;
  }
}

/** Write the ownership marker for a freshly added worktree. Best effort - never blocks a create. */
export async function writeWorktreeOwner(worktreePath: string, boardId = currentBoardInstanceId()): Promise<void> {
  try {
    let adminDir = adminDirFromGitFile(worktreePath);
    if (!adminDir) {
      const res = await gitExec(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath });
      if (res.error) return;
      adminDir = res.stdout.trim();
    }
    if (!adminDir) return;
    await mkdir(dirname(join(adminDir, WORKTREE_OWNER_FILE)), { recursive: true });
    await writeFile(join(adminDir, WORKTREE_OWNER_FILE), `${boardId}\n`, "utf-8");
  } catch {
    // best effort
  }
}

/** The board id recorded for this worktree, or null when unmarked/unreadable. */
export function readWorktreeOwner(worktreePath: string): string | null {
  const adminDir = adminDirFromGitFile(worktreePath);
  if (!adminDir) return null;
  try {
    const text = readFileSync(join(adminDir, WORKTREE_OWNER_FILE), "utf-8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** True when a marker exists and names a board other than `boardId`. */
export function isOwnedByOtherBoard(worktreePath: string, boardId = currentBoardInstanceId()): string | null {
  const owner = readWorktreeOwner(worktreePath);
  return owner !== null && owner !== boardId ? owner : null;
}
