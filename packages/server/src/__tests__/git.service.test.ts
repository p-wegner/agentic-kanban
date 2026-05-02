import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import * as gitService from "../services/git.service.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kanban-git-test-"));
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);

  // Create initial commit on main
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);

  // Rename to main if needed
  try {
    await exec("git", ["branch", "-M", "main"], dir);
  } catch {
    // Already on main
  }

  return dir;
}

describe("GitService", () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await createTempRepo();
  });

  afterAll(async () => {
    try {
      await rm(repoPath, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it("creates a worktree for a new branch", async () => {
    const worktreePath = await gitService.createWorktree(repoPath, "feature/test-branch");

    // Verify worktree directory exists
    const { stat } = await import("node:fs/promises");
    const s = await stat(worktreePath);
    expect(s.isDirectory()).toBe(true);

    // Verify it has the README from the main branch
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(worktreePath, "README.md"), "utf-8");
    expect(content).toContain("# Test");

    // Cleanup
    await gitService.removeWorktree(repoPath, worktreePath);
  });

  it("reuses existing worktree for an already-checked-out branch", async () => {
    const worktreePath = await gitService.createWorktree(repoPath, "feature/dup-test");

    try {
      const reusedPath = await gitService.createWorktree(repoPath, "feature/dup-test");
      expect(reusedPath).toBe(worktreePath);
    } finally {
      await gitService.removeWorktree(repoPath, worktreePath);
    }
  });

  it("gets diff between worktree and base branch", async () => {
    const worktreePath = await gitService.createWorktree(repoPath, "feature/diff-test");

    // Make a change in the worktree
    const { writeFileSync, appendFileSync } = await import("node:fs");
    appendFileSync(join(worktreePath, "README.md"), "\nNew content\n");
    writeFileSync(join(worktreePath, "new-file.txt"), "Hello\n");

    await exec("git", ["add", "."], worktreePath);
    await exec("git", ["config", "user.email", "test@test.com"], worktreePath);
    await exec("git", ["config", "user.name", "Test"], worktreePath);
    await exec("git", ["commit", "-m", "Add changes"], worktreePath);

    const diff = await gitService.getDiff(worktreePath, "main");
    expect(diff).toContain("New content");

    await gitService.removeWorktree(repoPath, worktreePath);
  });

  it("merges a branch", async () => {
    const worktreePath = await gitService.createWorktree(repoPath, "feature/merge-test");

    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(worktreePath, "merge-file.txt"), "Merge me\n");

    await exec("git", ["add", "."], worktreePath);
    await exec("git", ["config", "user.email", "test@test.com"], worktreePath);
    await exec("git", ["config", "user.name", "Test"], worktreePath);
    await exec("git", ["commit", "-m", "Add merge file"], worktreePath);

    await gitService.removeWorktree(repoPath, worktreePath);

    const result = await gitService.mergeBranch(repoPath, "feature/merge-test");
    expect(result).toContain("Merge");

    // Verify file exists in main
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(repoPath, "merge-file.txt"), "utf-8");
    expect(content.trim()).toBe("Merge me");
  });
});
