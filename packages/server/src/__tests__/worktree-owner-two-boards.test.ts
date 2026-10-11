/**
 * #1375 - two boards (stable + dev) share one repo. Board B's startup reconcile must leave board
 * A's fresh 0-commit worktree alone (and say why), still reap its own orphan, and a REFUSED
 * remove must leave the directory intact.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileOrphanedWorktrees, type OrphanedWorktreeGitPort } from "../startup/orphaned-worktree-reconciler.js";
import { readWorktreeOwner, writeWorktreeOwner } from "@agentic-kanban/shared/lib/git-service/worktree-owner";
import { removeWorktree } from "@agentic-kanban/shared/lib/git-service/worktree";

const REPO = "C:/projects/the-organisation/repo-1375";
const guardDb = () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }) as never;

/** A fake linked worktree: `.git` file -> admin dir, as `git worktree add` leaves it. */
async function fakeWorktree(root: string, name: string): Promise<string> {
  const wt = join(root, name);
  const admin = join(root, "admin", name);
  await mkdir(wt, { recursive: true });
  await mkdir(admin, { recursive: true });
  await writeFile(join(wt, ".git"), `gitdir: ${admin}\n`);
  return wt;
}

describe("#1375 worktree ownership", () => {
  it("board B keeps board A's fresh worktree (logged) and still removes its own orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanban-1375-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await fakeWorktree(root, "ak-1373");
      const b = await fakeWorktree(root, "ak-9");
      await writeWorktreeOwner(a, "board-A");
      await writeWorktreeOwner(b, "board-B");
      expect(readWorktreeOwner(a)).toBe("board-A");

      const removeWt = vi.fn(async () => {});
      const git: OrphanedWorktreeGitPort = {
        listWorktrees: async () => [{ path: REPO, branch: "master" }, { path: a, branch: "feature/ak-1373-x" }, { path: b, branch: "feature/ak-9-y" }],
        removeWorktree: removeWt,
        revParse: async () => "abc",
        countUniqueCommits: async () => 0,
        getWorkingTreeDiff: async () => "",
      };
      const report = await reconcileOrphanedWorktrees({ repoPath: REPO, baseBranch: "master", claims: [], git, database: guardDb(), boardId: "board-B" });

      expect(report.removed).toEqual([b]);
      expect(removeWt).toHaveBeenCalledTimes(1);
      expect(report.keptClaimed).toEqual([a]);
      expect(warn.mock.calls.some(([m]) => /keeping worktree .*ak-1373.* owned by board board-A/.test(String(m)))).toBe(true);
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a refused remove leaves the directory intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanban-1375-"));
    try {
      const wt = await fakeWorktree(root, "ak-1373");
      await writeFile(join(wt, "work.txt"), "builder output");
      // `root` is not under <repo>/../.worktrees, so the containment guard refuses.
      await expect(removeWorktree(join(root, "repo"), wt)).rejects.toThrow(/Refusing to recursively remove/);
      expect((await stat(join(wt, "work.txt"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
