// @covers workspaces.multiRepo.batchStatus [perf,parity]
/**
 * #415 — GET /api/projects/:id/workspace-repo-status (the batched cross-repo read).
 *
 * (1) PARITY: for a seeded multi-repo workspace the batch returns the same facts as the
 *     per-workspace endpoints (repo-merge-status / conflicts / handoff / diff?stats=1),
 *     computed against the same injected git seam.
 * (2) Scope: closed and direct workspaces are excluded.
 * (3) Route: 304 on unchanged If-None-Match; the ~10s memo means the repeat request
 *     does not recompute (no additional git calls).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

// ── git-exec seam mock (route-level tests go through the REAL git.service) ──────
const gitExecCalls: string[][] = [];
function canned(args: string[]): string {
  if (args[0] === "rev-parse") return "abc123";
  if (args[0] === "rev-list") return "2";
  if (args[0] === "merge-tree") return "cleantreesha";
  if (args[0] === "diff") return " 1 file changed, 10 insertions(+), 1 deletion(-)";
  return "";
}
vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  DEFAULT_GIT_TIMEOUT_MS: 10 * 60_000,
  GIT_CONTROL_OPERATION_LABEL: "git:control",
  GIT_SPAWN_SLOTS: 8,
  GIT_DEDUPE_MEMO_TTL_MS: 1500,
  __resetGitExecSchedulerForTests: () => {},
  gitExec: vi.fn(async (args: string[]) => {
    gitExecCalls.push(args);
    return { stdout: canned(args), stderr: "", code: 0 };
  }),
  gitExecOrThrow: vi.fn(async (args: string[]) => {
    gitExecCalls.push(args);
    return canned(args);
  }),
  gitExecSync: vi.fn((args: string[]) => {
    gitExecCalls.push(args);
    return canned(args);
  }),
  gitStream: vi.fn(() => {
    throw new Error("gitStream not expected in these tests");
  }),
}));

import {
  buildWorkspaceRepoStatusBatch,
  __resetWorkspaceRepoStatusMemoForTests,
  parseIncludeParam,
} from "../services/workspace-repo-status-batch.service.js";
import { getRepoMergeStatus } from "../services/repo-merge-status.service.js";
import { createWorkspaceDiffService } from "../services/workspace-diff.service.js";
import { createProjectsRoute } from "../routes/projects.js";

const ALL = parseIncludeParam("merge,conflicts,handoff,diffstats");

const tempDirs: string[] = [];
function makeWorktree(label: string, withHandoff: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `wrsb-${label}-`));
  writeFileSync(join(dir, ".git"), "gitdir: /nowhere\n", "utf-8");
  if (withHandoff) writeFileSync(join(dir, "HANDOFF.md"), `# Session Handoff\n${label} content\n`, "utf-8");
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  while (tempDirs.length > 0) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

let db: TestDb;
let projectId: string;
let workspaceId: string;
let leadWorktree: string;
let sibWorktree: string;

function fakeGit(): GitService {
  return {
    revParse: async () => "abc123",
    countUniqueCommits: async () => 2,
    detectConflicts: async (dir: string) =>
      dir.includes("sib")
        ? { hasConflicts: true, conflictingFiles: ["s.ts"] }
        : { hasConflicts: false, conflictingFiles: [] },
    getDiffShortstat: async (dir: string) =>
      dir.includes("sib")
        ? { filesChanged: 2, insertions: 20, deletions: 2 }
        : { filesChanged: 1, insertions: 10, deletions: 1 },
  } as unknown as GitService;
}

beforeEach(async () => {
  __resetWorkspaceRepoStatusMemoForTests();
  gitExecCalls.length = 0;
  ({ db } = createTestDb());
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Batch", repoPath: "/lead-repo", repoName: "lead",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "t", statusId, projectId, createdAt: now, updatedAt: now });
  workspaceId = randomUUID();
  leadWorktree = makeWorktree("lead", true);
  sibWorktree = makeWorktree("sib", false);
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: leadWorktree,
    baseBranch: "main", isDirect: false, status: "idle", createdAt: now, updatedAt: now,
  });
  await insertWorkspaceRepo({
    workspaceId, projectId, path: "/sib-repo", name: "sib",
    worktreePath: sibWorktree, branch: "feature/ak-1", baseBranch: "main",
  }, db);
});

describe("workspace-repo-status batch — parity with the per-workspace endpoints", () => {
  it("returns the same merge/conflicts/handoff/diffstats facts as the singles", async () => {
    const git = fakeGit();
    const database = db as unknown as Database;

    const batch = await buildWorkspaceRepoStatusBatch(projectId, ALL, { database, gitService: git });
    expect(batch.workspaces).toHaveLength(1);
    const entry = batch.workspaces[0];
    expect(entry.workspaceId).toBe(workspaceId);

    const single = await getRepoMergeStatus(workspaceId, { database, gitService: git });
    expect(entry.mergeStatus).toEqual(single);

    const diffSvc = createWorkspaceDiffService({ database, gitService: git });
    expect(entry.conflicts).toEqual(await diffSvc.getConflicts(workspaceId));
    expect(entry.handoff).toEqual(await diffSvc.getHandoff(workspaceId));
    expect(entry.diffStats).toEqual(await diffSvc.getWorkspaceDiffStats(workspaceId));

    // Sanity on content, not just parity-of-two-nulls:
    expect(entry.mergeStatus!.repos).toHaveLength(2);
    expect(entry.mergeStatus!.repos[0].isLeading).toBe(true);
    expect(entry.mergeStatus!.repos.every((r) => r.hasWork && r.stranded)).toBe(true);
    expect(entry.conflicts).toEqual({ hasConflicts: true, conflictingFiles: ["s.ts"] });
    expect(entry.handoff!.exists).toBe(true);
    expect(entry.handoff!.repos).toHaveLength(2);
    expect(entry.diffStats!.stats).toEqual({ filesChanged: 3, insertions: 30, deletions: 3 });
  });

  it("skips conflict probes when everything is landed (empty shape, no git conflict calls)", async () => {
    // Stamp the workspace + sibling as merged: mergedHeadSha short-circuits to merged.
    const { eq } = await import("drizzle-orm");
    const { repos: reposTable, workspaces: wsTable } = await import("@agentic-kanban/shared/schema");
    await db.update(wsTable).set({ mergedHeadSha: "deadbeef" }).where(eq(wsTable.id, workspaceId));
    await db.update(reposTable).set({ mergedHeadSha: "deadbeef" }).where(eq(reposTable.workspaceId, workspaceId));

    const detectConflicts = vi.fn();
    const git = { ...fakeGit(), detectConflicts } as unknown as GitService;
    const batch = await buildWorkspaceRepoStatusBatch(projectId, ALL, { database: db as unknown as Database, gitService: git });
    const entry = batch.workspaces[0];
    expect(entry.mergeStatus!.allMerged).toBe(true);
    expect(entry.conflicts).toEqual({ hasConflicts: false, conflictingFiles: [] });
    expect(detectConflicts).not.toHaveBeenCalled();
  });

  it("excludes closed and direct workspaces", async () => {
    const now = new Date().toISOString();
    const statusRow = await db.select().from(projectStatuses).limit(1);
    const closedIssue = randomUUID();
    await db.insert(issues).values({ id: closedIssue, issueNumber: 2, title: "c", statusId: statusRow[0].id, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({
      id: randomUUID(), issueId: closedIssue, branch: "feature/ak-2", workingDir: null,
      baseBranch: "main", isDirect: false, status: "closed", createdAt: now, updatedAt: now,
    });
    const directIssue = randomUUID();
    await db.insert(issues).values({ id: directIssue, issueNumber: 3, title: "d", statusId: statusRow[0].id, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({
      id: randomUUID(), issueId: directIssue, branch: "main", workingDir: "/lead-repo",
      baseBranch: null, isDirect: true, status: "idle", createdAt: now, updatedAt: now,
    });

    const batch = await buildWorkspaceRepoStatusBatch(projectId, ALL, { database: db as unknown as Database, gitService: fakeGit() });
    expect(batch.workspaces.map((w) => w.workspaceId)).toEqual([workspaceId]);
  });
});

describe("workspace-repo-status batch — route (ETag + memo)", () => {
  function app() {
    const a = new Hono();
    a.route("/api/projects", createProjectsRoute(db as unknown as Database));
    return a;
  }

  it("answers 304 on unchanged If-None-Match without recomputing (memo)", async () => {
    const a = app();
    const url = `/api/projects/${projectId}/workspace-repo-status?include=merge,conflicts,handoff,diffstats`;

    const res1 = await a.request(url);
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const body = await res1.json();
    expect(body.workspaces).toHaveLength(1);
    const callsAfterFirst = gitExecCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // the real path did git work once

    const res2 = await a.request(url, { headers: { "If-None-Match": etag } });
    expect(res2.status).toBe(304);
    expect(await res2.text()).toBe("");
    expect(res2.headers.get("ETag")).toBe(etag);
    // The memo answered — zero additional git work.
    expect(gitExecCalls.length).toBe(callsAfterFirst);
  });

  it("defaults include to merge,conflicts,handoff when the param is absent", async () => {
    const a = app();
    const res = await a.request(`/api/projects/${projectId}/workspace-repo-status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.include).toEqual(["merge", "conflicts", "handoff"]);
    expect(body.workspaces[0].diffStats).toBeNull();
    expect(body.workspaces[0].mergeStatus).not.toBeNull();
  });
});
