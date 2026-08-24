// @covers workspaces.cleanup.stale-worktree-shared-workingdir [error]
//
// #673 defect 3: closing one of two workspaces sharing a workingDir must not delete the
// directory out from under the other. `deleteWorkspace` already guards this (workspace-crud
// .service.ts's `sharedByOthers` check); `removeStaleWorktree` (backing
// DELETE /api/workspaces/:id/stale-worktree, and reused by `retryCleanup`) did not — it
// validated the workspace was closed and the path safe, then removed the directory with no
// check for another workspace still referencing it.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCleanupService } from "../services/workspace-cleanup.service.js";

function makeGitService(overrides: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async (_repo: string, branch: string) => `/tmp/worktrees/${branch}`),
    removeWorktree: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadCommitSha: vi.fn(async () => "abc123"),
    revParse: vi.fn(async () => "abc123"),
    pruneWorktrees: vi.fn(async () => {}),
    listWorktrees: vi.fn(async () => []),
    ensureOnBranch: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("removeStaleWorktree does not delete a workingDir another workspace still shares (#673)", () => {
  let tmpRoot: string;
  let repoPath: string;
  let workingDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ak-673-stale-"));
    repoPath = join(tmpRoot, "repo");
    workingDir = join(tmpRoot, ".worktrees", "ak-670");
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seed(db: ReturnType<typeof createTestDb>["db"]) {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test Project", repoPath, repoName: "repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 670, title: "Shared workingDir", description: null,
      priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
    });
    return { projectId, issueId, now };
  }

  it("skips removal and reports the sharer when another workspace still references the workingDir", async () => {
    const { db } = createTestDb();
    const { issueId, now } = await seed(db);

    // The closed workspace whose stale-worktree cleanup we're about to run...
    await db.insert(workspaces).values({
      id: "closed-ws", issueId, branch: "feature/ak-670-x", workingDir,
      baseBranch: "main", isDirect: false, status: "closed", provider: "claude",
      createdAt: now, updatedAt: now,
    });
    // ...and a STILL-LIVE workspace sharing the exact same directory.
    await db.insert(workspaces).values({
      id: "live-ws", issueId, branch: "feature/ak-670-x", workingDir,
      baseBranch: "main", isDirect: false, status: "active", provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const gitService = makeGitService();
    const cleanup = createWorkspaceCleanupService({ database: db, gitService: gitService as never });

    const result = await cleanup.removeStaleWorktree("closed-ws");

    expect(result.success).toBe(false);
    expect(result.error).toContain("still referenced by");
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("removes the directory when no other workspace shares it", async () => {
    const { db } = createTestDb();
    const { issueId, now } = await seed(db);
    await db.insert(workspaces).values({
      id: "closed-ws", issueId, branch: "feature/ak-670-x", workingDir,
      baseBranch: "main", isDirect: false, status: "closed", provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const gitService = makeGitService();
    const cleanup = createWorkspaceCleanupService({ database: db, gitService: gitService as never });

    const result = await cleanup.removeStaleWorktree("closed-ws");

    expect(result.success).toBe(true);
    expect(gitService.removeWorktree).toHaveBeenCalledWith(repoPath, workingDir);
  });

  it("removes the directory when the only other sharer is ALSO closed (no live-vs-live deadlock)", async () => {
    const { db } = createTestDb();
    const { issueId, now } = await seed(db);

    // Both workspaces are closed — e.g. the original EBUSY-stuck pair from #670's repro.
    // A sharer-check that ignores status would have these two block each other forever.
    await db.insert(workspaces).values({
      id: "closed-ws", issueId, branch: "feature/ak-670-x", workingDir,
      baseBranch: "main", isDirect: false, status: "closed", provider: "claude",
      createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: "closed-ws-2", issueId, branch: "feature/ak-670-x", workingDir,
      baseBranch: "main", isDirect: false, status: "closed", provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const gitService = makeGitService();
    const cleanup = createWorkspaceCleanupService({ database: db, gitService: gitService as never });

    const result = await cleanup.removeStaleWorktree("closed-ws");

    expect(result.success).toBe(true);
    expect(gitService.removeWorktree).toHaveBeenCalledWith(repoPath, workingDir);
  });
});
