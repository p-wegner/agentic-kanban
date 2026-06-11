import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { getProjectGitStats, getProjectGitStatsAsync } from "../services/git-info.service.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

async function initRepoWithSources(prefix: string): Promise<{ repoDir: string; branch: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), prefix));
  await exec("git", ["init"], repoDir);
  await exec("git", ["config", "user.email", "test@test.com"], repoDir);
  await exec("git", ["config", "user.name", "Test"], repoDir);

  await mkdir(join(repoDir, "src", "__tests__"), { recursive: true });
  // 3 non-empty production lines, 2 non-empty test lines
  await writeFile(join(repoDir, "src", "app.ts"), "const a = 1;\nconst b = 2;\nexport { a, b };\n", "utf8");
  await writeFile(join(repoDir, "src", "__tests__", "app.test.ts"), "import { a } from '../app';\nconsole.log(a);\n", "utf8");
  await exec("git", ["add", "."], repoDir);
  await exec("git", ["commit", "-m", "first commit"], repoDir);
  await exec("git", ["commit", "--allow-empty", "-m", "second commit"], repoDir);

  const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
  return { repoDir, branch };
}

describe("getProjectGitStatsAsync", () => {
  let repoDir: string;
  let branchName: string;

  beforeAll(async () => {
    ({ repoDir, branch: branchName } = await initRepoWithSources("kanban-stats-async-"));
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("computes commit stats, code metrics, history, and hotspots (cold path)", async () => {
    const stats = await getProjectGitStatsAsync(repoDir, branchName);

    expect(stats.commitCount).toBe(2);
    expect(stats.detectedBranch).toBe(branchName);
    expect(stats.recentCommits).toHaveLength(2);
    expect(stats.recentCommits[0].message).toBe("second commit");
    for (const commit of stats.recentCommits) {
      expect(commit.hash).toHaveLength(7);
      expect(typeof commit.message).toBe("string");
      expect(typeof commit.date).toBe("string");
    }

    expect(stats.codeMetrics.sourceFilesScanned).toBe(2);
    expect(stats.codeMetrics.productionFiles).toBe(1);
    expect(stats.codeMetrics.testFiles).toBe(1);
    expect(stats.codeMetrics.productionLoc).toBe(3);
    expect(stats.codeMetrics.testLoc).toBe(2);
    expect(stats.codeMetrics.totalLoc).toBe(5);
    expect(stats.codeMetrics.testRatio).toBe(40);

    expect(stats.history.weeks).toHaveLength(12);
    const totalCommitsInWeeks = stats.history.weeks.reduce((sum, w) => sum + w.commits, 0);
    expect(totalCommitsInWeeks).toBe(2);
    expect(stats.history.contributorCount).toBe(1);
    expect(stats.history.topContributors[0]).toEqual({ name: "Test", commits: 2 });

    const hotspotPaths = stats.hotspots.map((h) => h.path);
    expect(hotspotPaths).toContain("src/app.ts");
    expect(hotspotPaths).toContain("src/__tests__/app.test.ts");
  });

  it("matches the sync implementation field-for-field", async () => {
    const asyncStats = await getProjectGitStatsAsync(repoDir, branchName);
    const syncStats = getProjectGitStats(repoDir, branchName);

    expect(asyncStats.commitCount).toBe(syncStats.commitCount);
    expect(asyncStats.detectedBranch).toBe(syncStats.detectedBranch);
    expect(asyncStats.recentCommits.map((c) => c.hash)).toEqual(syncStats.recentCommits.map((c) => c.hash));
    expect(asyncStats.recentCommits.map((c) => c.message)).toEqual(syncStats.recentCommits.map((c) => c.message));
    // generatedAt is a timestamp; compare the numeric metrics only
    const { generatedAt: _a, ...asyncMetrics } = asyncStats.codeMetrics;
    const { generatedAt: _s, ...syncMetrics } = syncStats.codeMetrics;
    expect(asyncMetrics).toEqual(syncMetrics);
    expect(asyncStats.history).toEqual(syncStats.history);
    expect(asyncStats.hotspots).toEqual(syncStats.hotspots);
  });

  it("auto-detects branch when defaultBranch is null", async () => {
    const stats = await getProjectGitStatsAsync(repoDir, null);
    expect(stats.commitCount).toBe(2);
    expect(stats.detectedBranch).toMatch(/^(main|master)$/);
  });

  it("returns zero commits and empty metrics for a non-existent repo path", async () => {
    const stats = await getProjectGitStatsAsync("C:\\nonexistent\\path", "main");
    expect(stats.commitCount).toBe(0);
    expect(stats.recentCommits).toHaveLength(0);
    expect(stats.detectedBranch).toBe("main");
    expect(stats.codeMetrics.sourceFilesScanned).toBe(0);
    expect(stats.hotspots).toHaveLength(0);
  });

  it("returns null detectedBranch when no main/master exists and defaultBranch is null", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "kanban-stats-async-custom-"));
    try {
      await exec("git", ["init", "-b", "develop"], customDir);
      await exec("git", ["config", "user.email", "test@test.com"], customDir);
      await exec("git", ["config", "user.name", "Test"], customDir);
      await exec("git", ["commit", "--allow-empty", "-m", "init"], customDir);

      const stats = await getProjectGitStatsAsync(customDir, null);
      expect(stats.detectedBranch).toBeNull();
      expect(stats.commitCount).toBe(0);
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent cold computations into one shared in-flight promise", async () => {
    // Fresh repo so the 60s HEAD-keyed metrics cache is cold for this key
    const { repoDir: dedupeDir, branch } = await initRepoWithSources("kanban-stats-async-dedupe-");
    try {
      const [a, b, c] = await Promise.all([
        getProjectGitStatsAsync(dedupeDir, branch),
        getProjectGitStatsAsync(dedupeDir, branch),
        getProjectGitStatsAsync(dedupeDir, branch),
      ]);
      // Shared in-flight compute resolves all callers with the SAME metrics objects;
      // independent computes would produce distinct (if equal) objects.
      expect(b.codeMetrics).toBe(a.codeMetrics);
      expect(c.codeMetrics).toBe(a.codeMetrics);
      expect(b.history).toBe(a.history);
      expect(b.hotspots).toBe(a.hotspots);
      expect(a.commitCount).toBe(2);
    } finally {
      await rm(dedupeDir, { recursive: true, force: true });
    }
  });

  it("serves warm requests from the shared HEAD-keyed cache (sync and async share it)", async () => {
    const syncStats = getProjectGitStats(repoDir, branchName);
    const asyncStats = await getProjectGitStatsAsync(repoDir, branchName);
    // Same cache entry => identical object references for the cached metrics portion
    expect(asyncStats.codeMetrics).toBe(syncStats.codeMetrics);
    expect(asyncStats.history).toBe(syncStats.history);
    expect(asyncStats.hotspots).toBe(syncStats.hotspots);
  });
});
