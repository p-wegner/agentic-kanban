import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

  it("aborts merge on conflict and leaves main checkout clean", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");

    // Create branch A: modify shared-file with "branch A content"
    const worktreeA = await gitService.createWorktree(repoPath, "feature/conflict-a");
    writeFileSync(join(worktreeA, "shared-conflict.txt"), "branch A content\n");
    await exec("git", ["add", "."], worktreeA);
    await exec("git", ["config", "user.email", "test@test.com"], worktreeA);
    await exec("git", ["config", "user.name", "Test"], worktreeA);
    await exec("git", ["commit", "-m", "branch A changes"], worktreeA);
    await gitService.removeWorktree(repoPath, worktreeA);

    // Merge branch A into main successfully
    await gitService.mergeBranch(repoPath, "feature/conflict-a");

    // Create branch B from BEFORE branch A was merged (i.e., from 2 commits ago, before the branch A changes)
    // We'll branch from the commit before the merge to simulate a parallel branch
    const mainHeadBeforeMerge = (await exec("git", ["rev-parse", "HEAD^"], repoPath)).trim();
    await exec("git", ["branch", "feature/conflict-b", mainHeadBeforeMerge], repoPath);
    const worktreeB = await gitService.createWorktree(repoPath, "feature/conflict-b");
    writeFileSync(join(worktreeB, "shared-conflict.txt"), "branch B content\n");
    await exec("git", ["add", "."], worktreeB);
    await exec("git", ["config", "user.email", "test@test.com"], worktreeB);
    await exec("git", ["config", "user.name", "Test"], worktreeB);
    await exec("git", ["commit", "-m", "branch B changes"], worktreeB);
    await gitService.removeWorktree(repoPath, worktreeB);

    // Try to merge branch B — should conflict and throw
    await expect(gitService.mergeBranch(repoPath, "feature/conflict-b")).rejects.toThrow();

    // MERGE_HEAD must NOT exist — merge was aborted
    const mergeHeadPath = join(repoPath, ".git", "MERGE_HEAD");
    expect(existsSync(mergeHeadPath)).toBe(false);

    // shared-conflict.txt must NOT contain conflict markers
    const content = readFileSync(join(repoPath, "shared-conflict.txt"), "utf-8");
    expect(content).not.toContain("<<<<<<<");
    expect(content).not.toContain("=======");
    expect(content).not.toContain(">>>>>>>");
  });

  it("aborts merge on _journal.json conflict and leaves main checkout clean", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");

    // Simulate the drizzle journal conflict scenario:
    // Two branches both add a migration with the same index (0001_*)
    const journalDir = join(repoPath, "meta");
    mkdirSync(journalDir, { recursive: true });

    // Base journal (committed on main before both branches diverge)
    const baseJournal = JSON.stringify({ version: "6", dialect: "sqlite", entries: [] }, null, 2);
    writeFileSync(join(journalDir, "_journal.json"), baseJournal);
    await exec("git", ["add", "."], repoPath);
    await exec("git", ["commit", "-m", "Add base journal"], repoPath);

    // Branch C: adds migration 0001_branch_c
    const worktreeC = await gitService.createWorktree(repoPath, "feature/journal-c");
    const journalC = JSON.stringify({ version: "6", dialect: "sqlite", entries: [{ idx: 0, version: "6", tag: "0001_branch_c", when: 1000, breakpoints: true }] }, null, 2);
    writeFileSync(join(join(worktreeC, "meta"), "_journal.json"), journalC);
    await exec("git", ["add", "."], worktreeC);
    await exec("git", ["config", "user.email", "test@test.com"], worktreeC);
    await exec("git", ["config", "user.name", "Test"], worktreeC);
    await exec("git", ["commit", "-m", "Add migration 0001_branch_c"], worktreeC);
    await gitService.removeWorktree(repoPath, worktreeC);

    // Merge branch C into main
    await gitService.mergeBranch(repoPath, "feature/journal-c");

    // Branch D from BEFORE C was merged: also adds 0001_branch_d
    const mainBeforeC = (await exec("git", ["rev-parse", "HEAD^"], repoPath)).trim();
    await exec("git", ["branch", "feature/journal-d", mainBeforeC], repoPath);
    const worktreeD = await gitService.createWorktree(repoPath, "feature/journal-d");
    const journalD = JSON.stringify({ version: "6", dialect: "sqlite", entries: [{ idx: 0, version: "6", tag: "0001_branch_d", when: 1001, breakpoints: true }] }, null, 2);
    writeFileSync(join(join(worktreeD, "meta"), "_journal.json"), journalD);
    await exec("git", ["add", "."], worktreeD);
    await exec("git", ["config", "user.email", "test@test.com"], worktreeD);
    await exec("git", ["config", "user.name", "Test"], worktreeD);
    await exec("git", ["commit", "-m", "Add migration 0001_branch_d"], worktreeD);
    await gitService.removeWorktree(repoPath, worktreeD);

    // Merging branch D should conflict on _journal.json and throw
    await expect(gitService.mergeBranch(repoPath, "feature/journal-d")).rejects.toThrow();

    // Main checkout must be clean — MERGE_HEAD absent
    const mergeHeadPath = join(repoPath, ".git", "MERGE_HEAD");
    expect(existsSync(mergeHeadPath)).toBe(false);

    // _journal.json must NOT contain conflict markers
    const journalContent = readFileSync(join(journalDir, "_journal.json"), "utf-8");
    expect(journalContent).not.toContain("<<<<<<<");
    expect(journalContent).not.toContain("=======");
    expect(journalContent).not.toContain(">>>>>>>");
  });
});
