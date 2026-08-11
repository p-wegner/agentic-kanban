// @covers workspaces.diff.statsVariant [perf]
/**
 * #415 — the `?stats=1` diff variant.
 *
 * (1) Service: `getWorkspaceDiffStats` returns per-repo shortstat numbers only (no diff
 *     bodies), one shortstat call per repo, serving the LEADING repo from the persisted
 *     diff_stat_cache columns when their stamp is fresh (zero leading spawns).
 * (2) Route: the stats variant answers a matching If-None-Match from the short-lived
 *     validator memo BEFORE computing anything; the full-diff variant never does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { createWorkspaceDiffService } from "../services/workspace-diff.service.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

// ── Route-level mock (only affects the route tests; service tests build the diff
//    service directly, bypassing workspace.service entirely). ──────────────────
const getWorkspaceDiff = vi.fn();
const getWorkspaceDiffStats = vi.fn();
vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({ getWorkspaceDiff, getWorkspaceDiffStats })),
}));

import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";

let db: TestDb;
let workspaceId: string;
let projectId: string;

async function seed(opts: { diffCacheFresh?: boolean } = {}) {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/x",
    workingDir: "/lead/.worktrees/feature-x",
    baseBranch: "main",
    ...(opts.diffCacheFresh
      ? {
          diffStatCacheCheckedAt: new Date().toISOString(),
          diffStatCacheHeadSha: "cachedsha",
          diffStatCacheFilesChanged: 4,
          diffStatCacheInsertions: 40,
          diffStatCacheDeletions: 4,
        }
      : {}),
  });
}

function shortstatGit(calls: string[]): GitService {
  return {
    getDiffShortstat: async (dir: string) => {
      calls.push(dir);
      return dir.includes("sibling")
        ? { filesChanged: 2, insertions: 20, deletions: 2 }
        : { filesChanged: 1, insertions: 10, deletions: 1 };
    },
  } as unknown as GitService;
}

describe("getWorkspaceDiffStats (#415)", () => {
  it("returns per-repo shortstat numbers with summed totals and NO diff bodies", async () => {
    await seed();
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: "/sibling",
      name: "sibling",
      worktreePath: "/sibling/.worktrees/feature-x",
      branch: "feature/x",
      baseBranch: "main",
    }, db);
    const calls: string[] = [];
    const svc = createWorkspaceDiffService({ database: db as unknown as Database, gitService: shortstatGit(calls) });

    const result = await svc.getWorkspaceDiffStats(workspaceId);

    expect(result.repos).toHaveLength(2);
    expect(result.repos[0]).toEqual({ name: null, path: "/lead", stats: { filesChanged: 1, insertions: 10, deletions: 1 } });
    expect(result.repos[1]).toEqual({ name: "sibling", path: "/sibling", stats: { filesChanged: 2, insertions: 20, deletions: 2 } });
    expect(result.stats).toEqual({ filesChanged: 3, insertions: 30, deletions: 3 });
    expect(result).not.toHaveProperty("diff");
    // Exactly one shortstat per repo — no full diff, no conflict probe.
    expect(calls).toHaveLength(2);
  });

  it("serves the leading repo from a fresh diff_stat_cache without spawning", async () => {
    await seed({ diffCacheFresh: true });
    const calls: string[] = [];
    const svc = createWorkspaceDiffService({ database: db as unknown as Database, gitService: shortstatGit(calls) });

    const result = await svc.getWorkspaceDiffStats(workspaceId);

    expect(result.repos[0].stats).toEqual({ filesChanged: 4, insertions: 40, deletions: 4 });
    expect(calls).toHaveLength(0); // single-repo + warm cache = zero git calls
  });
});

describe("GET /:id/diff?stats=1 route (#415)", () => {
  function makeApp() {
    const app = new Hono();
    app.route("/api/workspaces", createWorkspaceActionsRoute(() => ({}) as never, {} as never));
    return app;
  }

  it("answers a matching If-None-Match from the memo WITHOUT recomputing (within TTL)", async () => {
    const app = makeApp();
    getWorkspaceDiffStats.mockClear();
    getWorkspaceDiffStats.mockResolvedValue({ stats: { filesChanged: 1, insertions: 1, deletions: 0 }, repos: [] });

    const wsId = `ws-${randomUUID()}`;
    const res1 = await app.request(`/api/workspaces/${wsId}/diff?stats=1`);
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("ETag")!;
    expect(getWorkspaceDiffStats).toHaveBeenCalledTimes(1);

    const res2 = await app.request(`/api/workspaces/${wsId}/diff?stats=1`, { headers: { "If-None-Match": etag } });
    expect(res2.status).toBe(304);
    expect(res2.headers.get("ETag")).toBe(etag);
    // The point of the fix: the 304 cost ZERO computation.
    expect(getWorkspaceDiffStats).toHaveBeenCalledTimes(1);
  });

  it("keeps the stats and full variants on separate validators", async () => {
    const app = makeApp();
    getWorkspaceDiffStats.mockResolvedValue({ stats: { filesChanged: 1, insertions: 1, deletions: 0 }, repos: [] });
    getWorkspaceDiff.mockResolvedValue({ diff: "d", stats: { filesChanged: 1, insertions: 1, deletions: 0 }, comments: [], conflicts: null });

    const wsId = `ws-${randomUUID()}`;
    const statsRes = await app.request(`/api/workspaces/${wsId}/diff?stats=1`);
    const fullRes = await app.request(`/api/workspaces/${wsId}/diff`);
    expect(statsRes.headers.get("ETag")).not.toBe(fullRes.headers.get("ETag"));
  });
});
