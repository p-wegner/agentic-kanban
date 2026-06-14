import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createWorktree,
  deleteBranch,
  removeWorktree,
} from "../services/git.service.js";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout.trim();
}

/**
 * Integration tests over a REAL temp git repo for the #781 fix:
 *   - deleteWorkspace drops the (possibly unmerged) feature branch via force delete
 *   - createWorktree refreshes a reused, never-built-on branch onto the up-to-date base
 */
describe("git-service branch refresh / force delete (#781)", () => {
  let tempRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kanban-branch-refresh-"));
    repoPath = join(tempRoot, "repo");
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ["init", "-b", "master"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test"]);
    await git(repoPath, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoPath, "base.txt"), "v1\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("deleteBranch with force discards an unmerged branch", async () => {
    // Cut a feature branch and commit unique work to it (unmerged).
    await git(repoPath, ["branch", "feature/ak-1-x", "master"]);
    await git(repoPath, ["checkout", "feature/ak-1-x"]);
    await writeFile(join(repoPath, "feat.txt"), "wip\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "wip"]);
    await git(repoPath, ["checkout", "master"]);

    // Safe delete refuses an unmerged branch.
    await expect(deleteBranch(repoPath, "feature/ak-1-x")).rejects.toThrow();
    // Force delete drops it.
    await expect(
      deleteBranch(repoPath, "feature/ak-1-x", { force: true }),
    ).resolves.toBeUndefined();

    const branches = await git(repoPath, ["branch", "--list", "feature/ak-1-x"]);
    expect(branches).toBe("");
  });

  it("createWorktree re-cuts a reused never-built-on branch onto the advanced base", async () => {
    // A stale branch cut from the OLD master (pre-merge base), never built on.
    const staleBase = await git(repoPath, ["rev-parse", "master"]);
    await git(repoPath, ["branch", "feature/ak-2-y", "master"]);

    // master advances (the dependency merged).
    await writeFile(join(repoPath, "base.txt"), "v2\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "advance master"]);
    const newBase = await git(repoPath, ["rev-parse", "master"]);
    expect(newBase).not.toBe(staleBase);

    // Reuse the existing branch via createWorktree with the up-to-date base.
    const wtPath = await createWorktree(repoPath, "feature/ak-2-y", "master");

    // The branch must now point at the refreshed base, not the stale one.
    const refreshed = await git(repoPath, ["rev-parse", "feature/ak-2-y"]);
    expect(refreshed).toBe(newBase);

    await removeWorktree(repoPath, wtPath);
  });

  it("createWorktree leaves a reused branch WITH its own commits untouched", async () => {
    // A branch with unique unmerged work — must never be discarded on reuse.
    await git(repoPath, ["branch", "feature/ak-3-z", "master"]);
    await git(repoPath, ["checkout", "feature/ak-3-z"]);
    await writeFile(join(repoPath, "feat.txt"), "real work\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "real work"]);
    const ownTip = await git(repoPath, ["rev-parse", "feature/ak-3-z"]);
    await git(repoPath, ["checkout", "master"]);

    // master advances independently.
    await writeFile(join(repoPath, "base.txt"), "v2\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "advance master"]);

    const wtPath = await createWorktree(repoPath, "feature/ak-3-z", "master");

    // Branch tip is preserved (its own commit kept, not reset to base).
    const after = await git(repoPath, ["rev-parse", "feature/ak-3-z"]);
    expect(after).toBe(ownTip);

    await removeWorktree(repoPath, wtPath);
  });
});
