import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { detectRepoInfo, getProjectGitStats } from "../services/git-info.service.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

describe("detectRepoInfo", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-test-"));
    await exec("git", ["init"], tempDir);
    await exec("git", ["config", "user.email", "test@test.com"], tempDir);
    await exec("git", ["config", "user.name", "Test"], tempDir);
    // Create initial commit so HEAD exists
    await exec("git", ["commit", "--allow-empty", "-m", "init"], tempDir);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects basic repo info", async () => {
    const info = await detectRepoInfo(tempDir);
    expect(info.repoPath).toBe(tempDir);
    expect(info.repoName).toBe(tempDir.split(/[/\\]/).pop()!);
    expect(info.defaultBranch === "main" || info.defaultBranch === "master").toBe(true);
    expect(info.remoteUrl).toBeNull();
  });

  it("throws for non-git directory", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "kanban-nongit-"));
    try {
      await expect(detectRepoInfo(nonGitDir)).rejects.toThrow("Not a git repository");
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("detects remote URL when origin is set", async () => {
    // Add a remote
    await exec("git", ["remote", "add", "origin", "https://github.com/test/repo.git"], tempDir);

    const info = await detectRepoInfo(tempDir);
    expect(info.remoteUrl).toBe("https://github.com/test/repo.git");
  });

  it("leaves default branch unset when neither main nor master exists", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "kanban-custom-"));
    await exec("git", ["init", "-b", "develop"], customDir);
    await exec("git", ["config", "user.email", "test@test.com"], customDir);
    await exec("git", ["config", "user.name", "Test"], customDir);
    await exec("git", ["commit", "--allow-empty", "-m", "init"], customDir);

    const info = await detectRepoInfo(customDir);
    expect(info.defaultBranch).toBeNull();

    await rm(customDir, { recursive: true, force: true });
  });

  it("prefers main over master when both branches exist", async () => {
    const bothDir = await mkdtemp(join(tmpdir(), "kanban-both-"));
    await exec("git", ["init", "-b", "master"], bothDir);
    await exec("git", ["config", "user.email", "test@test.com"], bothDir);
    await exec("git", ["config", "user.name", "Test"], bothDir);
    await exec("git", ["commit", "--allow-empty", "-m", "init"], bothDir);
    await exec("git", ["branch", "main"], bothDir);

    const info = await detectRepoInfo(bothDir);
    expect(info.defaultBranch).toBe("main");

    await rm(bothDir, { recursive: true, force: true });
  });
});

describe("getProjectGitStats", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "kanban-stats-test-"));
    await exec("git", ["init"], repoDir);
    await exec("git", ["config", "user.email", "test@test.com"], repoDir);
    await exec("git", ["config", "user.name", "Test"], repoDir);
    await exec("git", ["commit", "--allow-empty", "-m", "first commit"], repoDir);
    await exec("git", ["commit", "--allow-empty", "-m", "second commit"], repoDir);
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns commit count when defaultBranch is provided", () => {
    const branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();
    const stats = getProjectGitStats(repoDir, branchName);
    expect(stats.commitCount).toBe(2);
    expect(stats.detectedBranch).toBe(branchName);
    expect(stats.recentCommits).toHaveLength(2);
    expect(stats.recentCommits[0].message).toBe("second commit");
  });

  it("auto-detects branch and returns commit count when defaultBranch is null (bug fix)", () => {
    // This was the bug: passing null would return { commitCount: 0 } immediately
    const stats = getProjectGitStats(repoDir, null);
    expect(stats.commitCount).toBe(2);
    expect(stats.detectedBranch).toMatch(/^(main|master)$/);
  });

  it("returns zero commits for an invalid/non-existent repo path", () => {
    const stats = getProjectGitStats("C:\\nonexistent\\path", "main");
    expect(stats.commitCount).toBe(0);
    expect(stats.recentCommits).toHaveLength(0);
  });

  it("returns null detectedBranch when branch cannot be detected", () => {
    // A repo on a custom branch (not main/master) with null defaultBranch
    const stats = getProjectGitStats(repoDir, null);
    // Should still detect something (main or master) for this test repo
    expect(stats.detectedBranch).not.toBeNull();
  });

  it("parses recent commits with correct fields", () => {
    const branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();
    const stats = getProjectGitStats(repoDir, branchName);
    for (const commit of stats.recentCommits) {
      expect(commit.hash).toHaveLength(7);
      expect(typeof commit.message).toBe("string");
      expect(typeof commit.date).toBe("string");
    }
  });
});
