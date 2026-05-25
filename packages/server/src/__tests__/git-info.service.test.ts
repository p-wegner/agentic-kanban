import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { detectRepoInfo } from "../services/git-info.service.js";

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

  it("resolves to git root when called from a subdirectory", async () => {
    const subDir = join(tempDir, "sub", "nested");
    await exec("git", ["config", "user.email", "test@test.com"], tempDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(subDir, { recursive: true });

    const info = await detectRepoInfo(subDir);
    // Should resolve to the git root, not the subdirectory
    expect(info.repoPath).toBe(tempDir);
    expect(info.repoName).toBe(tempDir.split(/[/\\]/).pop()!);
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
