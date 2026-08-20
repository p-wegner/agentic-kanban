import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import {
  collectCurrentCodeMetricsAsyncForTest,
  getProjectGitStatsAsync,
  hotspotLogArgs,
  HOTSPOT_FALLBACK_COMMIT_LIMIT_FOR_TEST,
  STALE_METRICS_BOUNDS_FOR_TEST,
  WALK_QUEUE_FLUSH_AT_FOR_TEST,
  __seedMetricsCacheForTests,
} from "../services/git-info.service.js";

function exec(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

async function initRepoWithSources(prefix: string): Promise<{ repoDir: string; branch: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), prefix));
  await exec("git", ["init"], repoDir);

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

  it("falls back to full history for hotspots when all churn is older than the 12-week window", async () => {
    // A repo whose only commits predate the windowed history would otherwise return
    // zero hotspots, leaving the Crime Scene / Hot Files views empty (#844).
    const oldDir = await mkdtemp(join(tmpdir(), "kanban-stats-async-old-"));
    try {
      await exec("git", ["init"], oldDir);
      await mkdir(join(oldDir, "src"), { recursive: true });
      await writeFile(join(oldDir, "src", "legacy.ts"), "const a = 1;\nconst b = 2;\nexport { a, b };\n", "utf8");
      await exec("git", ["add", "."], oldDir);
      // Commit dated ~1 year ago — well outside the 12-week (~84 day) history window.
      const oldDate = "2024-01-15T12:00:00";
      await exec("git", ["commit", "-m", "ancient commit"], oldDir, {
        GIT_AUTHOR_DATE: oldDate,
        GIT_COMMITTER_DATE: oldDate,
      });

      const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], oldDir);
      const stats = await getProjectGitStatsAsync(oldDir, branch);

      // No commits land inside the weekly window...
      expect(stats.history.weeks.reduce((sum, w) => sum + w.commits, 0)).toBe(0);
      // ...but hotspots are still populated via the full-history fallback.
      expect(stats.hotspots.map((h) => h.path)).toContain("src/legacy.ts");
    } finally {
      await rm(oldDir, { recursive: true, force: true });
    }
  });

  it("bounds the full-history hotspot fallback to a fixed commit count (so a hyperactive repo's scan can't time out and silently empty the Crime Scene view)", () => {
    // Regression for #844: on a very active repo, an unbounded `git log --numstat`
    // over thousands of commits runs ~8s+, blowing the timeout — both the windowed
    // scan and the (previously unbounded) fallback got killed, leaving 0 hotspots.
    // The fallback must cap the commits it scans so it always returns fast.
    const args = hotspotLogArgs("main");
    expect(args).toContain(`--max-count=${HOTSPOT_FALLBACK_COMMIT_LIMIT_FOR_TEST}`);
    expect(HOTSPOT_FALLBACK_COMMIT_LIMIT_FOR_TEST).toBeGreaterThan(0);
  });

  it("serves warm requests from the shared HEAD-keyed cache", async () => {
    // Fresh repo: the shared repoDir's cache entry can be older than the 60s TTL by
    // the time this test runs (each earlier test can take tens of seconds on a loaded
    // machine), and an EXPIRED entry is served stale-while-revalidate — a background
    // refresh would legitimately replace the objects and break the identity checks.
    // A cold compute here guarantees a fresh entry that the follow-up calls must hit.
    const { repoDir: warmDir, branch } = await initRepoWithSources("kanban-stats-async-warm-");
    try {
      const firstStats = await getProjectGitStatsAsync(warmDir, branch);
      const asyncStats = await getProjectGitStatsAsync(warmDir, branch);
      // Same cache entry => identical object references for the cached metrics portion
      expect(asyncStats.codeMetrics).toBe(firstStats.codeMetrics);
      expect(asyncStats.history).toBe(firstStats.history);
      expect(asyncStats.hotspots).toBe(firstStats.hotspots);

      // Regression: a THIRD call (async again) must still be served from cache — its
      // generatedAt must not move. An equal-but-freshly-recomputed object would pass an
      // `.toEqual()` check but must fail this: `generatedAt` would advance to "now".
      const generatedAtBefore = asyncStats.codeMetrics.generatedAt;
      const rewarmedStats = await getProjectGitStatsAsync(warmDir, branch);
      expect(rewarmedStats.codeMetrics.generatedAt).toBe(generatedAtBefore);
      expect(rewarmedStats.codeMetrics).toBe(asyncStats.codeMetrics);
    } finally {
      await rm(warmDir, { recursive: true, force: true });
    }
  }, 180_000); // repo init + cold compute exceed the default 60s under heavy machine load

  // #340: the 60s cache and the in-flight dedupe used to key on `git rev-parse <branch>`
  // and give up (cacheKey = null) when it failed — i.e. they switched themselves OFF
  // exactly under the load that makes rev-parse time out, so every concurrent stats
  // request started its own full source walk (the measured 132-509s, 4-deep pile-up).
  // An unresolvable head must now fall back to a deterministic repo+branch key.
  describe("unresolvable HEAD (#340)", () => {
    it("still caches the metrics blob under a repo+branch fallback key", async () => {
      const { repoDir: dir } = await initRepoWithSources("kanban-stats-async-nohead-");
      try {
        // A branch that does not exist: `git rev-parse <branch>` fails, so head is null.
        const first = await getProjectGitStatsAsync(dir, "no-such-branch");
        const second = await getProjectGitStatsAsync(dir, "no-such-branch");
        // Identical object reference => served from cache, not recomputed.
        expect(second.codeMetrics).toBe(first.codeMetrics);
        expect(second.codeMetrics.generatedAt).toBe(first.codeMetrics.generatedAt);
        expect(first.codeMetrics.sourceFilesScanned).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("still coalesces concurrent cold computes into one in-flight promise", async () => {
      const { repoDir: dir } = await initRepoWithSources("kanban-stats-async-nohead-dedupe-");
      try {
        const [a, b, c] = await Promise.all([
          getProjectGitStatsAsync(dir, "no-such-branch"),
          getProjectGitStatsAsync(dir, "no-such-branch"),
          getProjectGitStatsAsync(dir, "no-such-branch"),
        ]);
        expect(b.codeMetrics).toBe(a.codeMetrics);
        expect(c.codeMetrics).toBe(a.codeMetrics);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // #398 follow-up (G16): stale-while-revalidate used to have NO bound — the success
  // path was the only cache write, so when refresh failed forever the last-known-good
  // blob was served forever, with no error ever surfacing. The bound: after
  // MAX_CONSECUTIVE_REFRESH_FAILURES failed refreshes, or once the entry exceeds
  // MAX_STALE_SERVE_MS, the caller waits on the refresh instead of taking the stale blob.
  describe("bounded stale-while-revalidate (G16)", () => {
    /** Wait for a pending background refresh to land (fresh objects served), so `rm` can't race the walk on Windows. */
    async function drainBackgroundRefresh(dir: string, branch: string, staleBlob: { generatedAt: string }) {
      for (let i = 0; i < 100; i++) {
        const s = await getProjectGitStatsAsync(dir, branch);
        if (s.codeMetrics.generatedAt !== staleBlob.generatedAt) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    /** Cold-compute once to get a real metrics blob, then re-seed it as an EXPIRED entry. */
    async function seedStaleEntry(dir: string, branch: string, ageMs: number, failures: number) {
      const cold = await getProjectGitStatsAsync(dir, branch);
      const metrics = { codeMetrics: cold.codeMetrics, history: cold.history, hotspots: cold.hotspots };
      // Bogus head + old timestamp => entry is expired/not-usable, forcing the
      // stale-vs-wait decision on the next call.
      __seedMetricsCacheForTests(dir, branch, { timestamp: Date.now() - ageMs, head: "0000000000000000000000000000000000000000", metrics }, failures);
      return metrics;
    }

    it("within bounds, an expired entry is still served stale while the refresh runs", async () => {
      const { repoDir: dir, branch } = await initRepoWithSources("kanban-stats-async-stale-ok-");
      try {
        const seeded = await seedStaleEntry(dir, branch, 120_000, 0); // 2min old, no failures
        const stats = await getProjectGitStatsAsync(dir, branch);
        // Identity: the seeded stale blob was served, not a fresh compute.
        expect(stats.codeMetrics).toBe(seeded.codeMetrics);
        await drainBackgroundRefresh(dir, branch, seeded.codeMetrics);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("after too many consecutive refresh failures, the caller waits for a real refresh instead of the stale blob", async () => {
      const { repoDir: dir, branch } = await initRepoWithSources("kanban-stats-async-stale-fail-");
      try {
        const seeded = await seedStaleEntry(dir, branch, 120_000, STALE_METRICS_BOUNDS_FOR_TEST.MAX_CONSECUTIVE_REFRESH_FAILURES);
        const stats = await getProjectGitStatsAsync(dir, branch);
        // NOT the stale blob: a fresh compute was awaited (and here it succeeds,
        // which also resets the failure counter — a failing one would have thrown).
        expect(stats.codeMetrics).not.toBe(seeded.codeMetrics);
        expect(stats.codeMetrics.sourceFilesScanned).toBe(2);
        // Counter reset by the successful refresh: the next expired entry serves stale again.
        const reseeded = await seedStaleEntry(dir, branch, 120_000, 0);
        expect((await getProjectGitStatsAsync(dir, branch)).codeMetrics).toBe(reseeded.codeMetrics);
        await drainBackgroundRefresh(dir, branch, reseeded.codeMetrics);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 120_000);

    it("an entry older than the age cap is never served stale, even with zero failures", async () => {
      const { repoDir: dir, branch } = await initRepoWithSources("kanban-stats-async-stale-old-");
      try {
        const seeded = await seedStaleEntry(dir, branch, STALE_METRICS_BOUNDS_FOR_TEST.MAX_STALE_SERVE_MS + 1_000, 0);
        const stats = await getProjectGitStatsAsync(dir, branch);
        expect(stats.codeMetrics).not.toBe(seeded.codeMetrics);
        expect(stats.codeMetrics.sourceFilesScanned).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // #340: the walk had no wall-clock budget — only the individual git calls were capped
  // — so a contended libuv pool let it run for minutes, monopolising the single thread.
  describe("bounded source walk (#340)", () => {
    it("stops at the wall-clock budget and reports only what it actually scanned", async () => {
      const { repoDir: dir } = await initRepoWithSources("kanban-stats-async-budget-");
      try {
        const exhausted = await collectCurrentCodeMetricsAsyncForTest(dir, 0);
        // Partial, and visibly partial: the counters reflect reality rather than
        // silently claiming a complete scan.
        expect(exhausted.sourceFilesScanned).toBe(0);
        expect(exhausted.totalLoc).toBe(0);
        expect(exhausted.testRatio).toBe(0);

        // With a real budget the same repo is scanned in full.
        const complete = await collectCurrentCodeMetricsAsyncForTest(dir, 30_000);
        expect(complete.sourceFilesScanned).toBe(2);
        expect(complete.totalLoc).toBe(5);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("tallies every file across mid-walk queue flushes (bounded parallelism, not per-directory batches)", async () => {
      // More files than WALK_QUEUE_FLUSH_AT, spread over several directories, so the
      // queue is flushed mid-walk and refilled — the path a small fixture never reaches.
      const dir = await mkdtemp(join(tmpdir(), "kanban-stats-async-parallel-"));
      const fileCount = WALK_QUEUE_FLUSH_AT_FOR_TEST * 2 + 7;
      try {
        for (let i = 0; i < fileCount; i++) {
          const sub = join(dir, `pkg${i % 5}`);
          await mkdir(sub, { recursive: true });
          await writeFile(join(sub, `mod${i}.ts`), "const x = 1;\nexport { x };\n", "utf8");
        }

        const metrics = await collectCurrentCodeMetricsAsyncForTest(dir, 60_000);
        expect(metrics.sourceFilesScanned).toBe(fileCount);
        expect(metrics.productionFiles).toBe(fileCount);
        expect(metrics.totalLoc).toBe(fileCount * 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
