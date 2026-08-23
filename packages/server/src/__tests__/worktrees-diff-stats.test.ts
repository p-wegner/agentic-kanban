// #342: GET /api/projects/:id/worktrees measured 112.7s (then two 120s timeouts) on
// the dev project because it awaited one `git diff --shortstat` subprocess per
// non-main worktree inline, with no cache, no concurrency limit and no budget. These
// tests pin the replacement: zero inline git spawns, the workspace diff_stat_cache_*
// columns served for mapped worktrees, and a bounded background queue for the rest.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const listWorktreesMock = vi.fn<[], Promise<{ path: string; branch: string }[]>>();
const getDiffShortstatMock = vi.fn();

vi.mock("../services/git.service.js", () => ({
  listBranches: vi.fn(async () => []),
  listWorktrees: (...args: unknown[]) => listWorktreesMock(...(args as [])),
  getDiffShortstat: (...args: unknown[]) => getDiffShortstatMock(...args),
  removeWorktree: vi.fn(async () => {}),
}));

import { createProjectService } from "../services/project.service.js";
import {
  cachedWorktreeDiffStats,
  scheduleWorktreeDiffStatsRefresh,
  resetWorktreeDiffStatsCacheForTest,
  whenWorktreeDiffStatsIdle,
  WORKTREE_DIFF_STATS_CONCURRENCY,
  WORKTREE_DIFF_STATS_TTL_MS,
} from "../lib/worktree-diff-stats.js";

let db: TestDb;

beforeAll(() => {
  db = createTestDb().db;
});

beforeEach(() => {
  listWorktreesMock.mockReset();
  getDiffShortstatMock.mockReset().mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
  resetWorktreeDiffStatsCacheForTest();
});

/** Seed a project with one issue and one workspace bound to `workingDir`. */
async function seedProject(opts: {
  workingDir: string;
  diffCache?: {
    checkedAt: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Worktree Project",
    repoPath: "/tmp/worktree-repo",
    repoName: "worktree-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 7,
    title: "Cached diffstats",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-7-cached",
    workingDir: opts.workingDir,
    baseBranch: "main",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  // #815: the memo moved to `workspace_diff_stat_cache`. NO row is exactly what four NULL
  // columns were — a first sighting — so the no-cache case seeds nothing at all.
  if (opts.diffCache) {
    await db.insert(schema.workspaceDiffStatCache).values({
      workspaceId,
      checkedAt: opts.diffCache.checkedAt,
      filesChanged: opts.diffCache.filesChanged,
      insertions: opts.diffCache.insertions,
      deletions: opts.diffCache.deletions,
    });
  }
  return { projectId, workspaceId };
}

describe("getWorktrees diff stats (#342)", () => {
  it("serves a mapped worktree's diff stats from the workspace cache columns without spawning git", async () => {
    const workingDir = "/tmp/worktree-repo/.worktrees/feature-ak-7-cached";
    const { projectId } = await seedProject({
      workingDir,
      diffCache: {
        checkedAt: new Date().toISOString(),
        filesChanged: 4,
        insertions: 120,
        deletions: 17,
      },
    });
    listWorktreesMock.mockResolvedValue([
      { path: "/tmp/worktree-repo", branch: "refs/heads/main" },
      { path: workingDir, branch: "refs/heads/feature/ak-7-cached" },
    ]);

    const service = createProjectService({ database: db });
    const worktrees = await service.getWorktrees(projectId);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[1].diffStats).toEqual({ filesChanged: 4, insertions: 120, deletions: 17 });
    // The whole point: no `git diff --shortstat` subprocess for a mapped worktree.
    expect(getDiffShortstatMock).not.toHaveBeenCalled();
  });

  it("returns undefined diff stats on a first sighting and never blocks the request on git", async () => {
    const workingDir = "/tmp/worktree-repo/.worktrees/feature-ak-7-nocache";
    const { projectId } = await seedProject({ workingDir });
    listWorktreesMock.mockResolvedValue([
      { path: "/tmp/worktree-repo", branch: "refs/heads/main" },
      { path: workingDir, branch: "refs/heads/feature/ak-7-nocache" },
      // Unmapped: no workspace row, so no DB cache columns to read.
      { path: "/tmp/worktree-repo/.worktrees/orphan", branch: "refs/heads/feature/orphan" },
    ]);
    // A spawn that never settles would have hung the old inline implementation.
    getDiffShortstatMock.mockImplementation(() => new Promise(() => {}));

    const service = createProjectService({ database: db });
    const worktrees = await service.getWorktrees(projectId);

    expect(worktrees).toHaveLength(3);
    // Mapped workspace with an empty cache: nothing to show, and no inline spawn.
    expect(worktrees[1].diffStats).toBeUndefined();
    // Unmapped worktree: undefined on first paint, refresh queued in the background.
    expect(worktrees[2].diffStats).toBeUndefined();
    expect(worktrees[2].workspace).toBeUndefined();
    // Exactly one background compute was scheduled — only for the unmapped worktree.
    expect(getDiffShortstatMock).toHaveBeenCalledTimes(1);
    expect(getDiffShortstatMock).toHaveBeenCalledWith("/tmp/worktree-repo/.worktrees/orphan", "main");
  });
});

describe("worktree diff-stats background queue (#342)", () => {
  it("serves the value computed in the background on the next request", async () => {
    scheduleWorktreeDiffStatsRefresh("/wt/a", "main", async () => ({
      filesChanged: 2,
      insertions: 9,
      deletions: 1,
    }));
    expect(cachedWorktreeDiffStats("/wt/a", "main")).toBeUndefined();

    await whenWorktreeDiffStatsIdle();

    expect(cachedWorktreeDiffStats("/wt/a", "main")).toEqual({
      filesChanged: 2,
      insertions: 9,
      deletions: 1,
    });
  });

  it("treats an all-zero diff as nothing to show", async () => {
    scheduleWorktreeDiffStatsRefresh("/wt/zero", "main", async () => ({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    }));
    await whenWorktreeDiffStatsIdle();
    expect(cachedWorktreeDiffStats("/wt/zero", "main")).toBeUndefined();
  });

  it("caps concurrent computes, so 40 worktrees cannot become 40 parallel git spawns", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    for (let i = 0; i < 40; i++) {
      scheduleWorktreeDiffStatsRefresh(`/wt/many-${i}`, "main", () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise<{ filesChanged: number; insertions: number; deletions: number }>((resolve) => {
          release.push(() => {
            inFlight--;
            resolve({ filesChanged: 1, insertions: 1, deletions: 0 });
          });
        });
      });
    }

    // Let the queue start whatever it is willing to start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(WORKTREE_DIFF_STATS_CONCURRENCY);

    // Drain: releasing the in-flight batch must let the queue pull the next one.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await whenWorktreeDiffStatsIdle();

    expect(peak).toBe(WORKTREE_DIFF_STATS_CONCURRENCY);
    expect(cachedWorktreeDiffStats("/wt/many-39", "main")).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it("does not re-queue a fresh entry, but does once the TTL has passed", async () => {
    const compute = vi.fn(async () => ({ filesChanged: 3, insertions: 3, deletions: 0 }));
    const t0 = Date.now();

    scheduleWorktreeDiffStatsRefresh("/wt/ttl", "main", compute, t0);
    await whenWorktreeDiffStatsIdle();
    expect(compute).toHaveBeenCalledTimes(1);

    // Within the TTL a poll loop must not spawn anything.
    scheduleWorktreeDiffStatsRefresh("/wt/ttl", "main", compute, t0 + WORKTREE_DIFF_STATS_TTL_MS - 1);
    await whenWorktreeDiffStatsIdle();
    expect(compute).toHaveBeenCalledTimes(1);

    // Past the TTL it refreshes.
    scheduleWorktreeDiffStatsRefresh("/wt/ttl", "main", compute, Date.now() + WORKTREE_DIFF_STATS_TTL_MS);
    await whenWorktreeDiffStatsIdle();
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known value and rate-limits retries when a compute fails", async () => {
    const failing = vi.fn(async () => { throw new Error("git exploded"); });

    scheduleWorktreeDiffStatsRefresh("/wt/fail", "main", failing);
    await whenWorktreeDiffStatsIdle();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(cachedWorktreeDiffStats("/wt/fail", "main")).toBeUndefined();

    // A failure records the attempt, so the TTL gates the next try rather than the
    // next poll retrying immediately in a tight loop.
    scheduleWorktreeDiffStatsRefresh("/wt/fail", "main", failing);
    await whenWorktreeDiffStatsIdle();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
