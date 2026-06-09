/**
 * Column-count invariant tests for GET /api/projects/:id/board.
 *
 * Verifies three root causes of recurring board-cache staleness bugs
 * (#551, #552, #591):
 *
 *   1. PATCH /api/issues/:id (status change) → GET /board → correct column count
 *   2. Workspace merge        → GET /board → issue moved to Done column
 *   3. Workspace DELETE       → GET /board → workspaceSummary removed from issue
 *
 * Tests 1 and 3 use the full Hono HTTP stack (real route→service→cache→DB path).
 * Test 2 uses the service layer directly (DB update + boardEvents.broadcast), which
 * is exactly what the production merge workflow does, and avoids git-lock races on
 * Windows that would corrupt the afterEach temp-dir cleanup.
 *
 * Each test creates its own isolated project + statuses to avoid state leakage.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectsRoute } from "../routes/projects.js";
import { createWorkspacesRoute } from "../routes/workspaces.js";
import { createIssuesRoute } from "../routes/issues.js";
import { createBoardEvents } from "../services/board-events.js";
import { createProjectService } from "../services/project.service.js";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";

interface BoardIssue {
  id: string;
  statusName: string;
  workspaceSummary?: {
    total: number;
    active: number;
    idle: number;
    closed: number;
    main?: { id: string; branch: string; status: string } | null;
  };
}

interface BoardColumn {
  name: string;
  count: number;
  issues: BoardIssue[];
}

const tempRepos: string[] = [];

afterEach(() => {
  for (const repoPath of tempRepos.splice(0)) {
    try {
      rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Windows may hold git index locks briefly after workspace teardown — best-effort cleanup.
    }
  }
});

function createApp() {
  const { db } = createTestDb();
  const boardEvents = createBoardEvents();
  const app = new Hono();
  app.route("/api/projects", createProjectsRoute(db, { boardEvents }));
  app.route("/api/workspaces", createWorkspacesRoute(db, undefined, { boardEvents }));
  app.route("/api/issues", createIssuesRoute(db, { boardEvents }));
  return { app, db, boardEvents };
}

function createTempGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ak-invariant-"));
  tempRepos.push(repoPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });
  return repoPath;
}

async function seedProject(
  db: TestDb,
  repoPath: string,
  statuses: Array<{ name: string; sortOrder: number; isDefault?: boolean }>
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: `Invariant Test ${projectId.slice(0, 8)}`,
    repoPath,
    repoName: "invariant-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const s of statuses) {
    const id = randomUUID();
    statusIds[s.name] = id;
    await db.insert(schema.projectStatuses).values({
      id,
      projectId,
      name: s.name,
      sortOrder: s.sortOrder,
      isDefault: s.isDefault ?? false,
      createdAt: now,
    });
  }

  return { projectId, statusIds, now };
}

async function readBoard(app: Hono, projectId: string): Promise<BoardColumn[]> {
  const res = await app.request(`/api/projects/${projectId}/board`);
  expect(res.status).toBe(200);
  return (await res.json()) as BoardColumn[];
}

function columnCount(board: BoardColumn[], name: string): number {
  return board.find((c) => c.name === name)?.count ?? 0;
}

function issueInColumn(board: BoardColumn[], columnName: string, issueId: string): boolean {
  return board.find((c) => c.name === columnName)?.issues.some((i) => i.id === issueId) ?? false;
}

describe("board column-count invariants", () => {
  describe("1. PATCH /api/issues/:id status → GET /board column counts update", () => {
    it("moves issue from Backlog to In Progress column after PATCH statusId", async () => {
      const { app, db } = createApp();
      const repoPath = createTempGitRepo();
      const { projectId, statusIds, now } = await seedProject(db, repoPath, [
        { name: "Backlog", sortOrder: 0, isDefault: true },
        { name: "In Progress", sortOrder: 1 },
      ]);

      const issueId = randomUUID();
      await db.insert(schema.issues).values({
        id: issueId,
        issueNumber: 1,
        title: "Column count invariant issue",
        statusId: statusIds["Backlog"],
        projectId,
        skipAutoReview: true,
        createdAt: now,
        updatedAt: now,
      });

      // Warm the cache — 1 in Backlog, 0 in In Progress.
      let board = await readBoard(app, projectId);
      expect(columnCount(board, "Backlog")).toBe(1);
      expect(columnCount(board, "In Progress")).toBe(0);
      expect(issueInColumn(board, "Backlog", issueId)).toBe(true);

      // PATCH status to In Progress via the issues HTTP route.
      const patchRes = await app.request(`/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusId: statusIds["In Progress"] }),
      });
      expect(patchRes.status).toBe(200);

      // GET /board must immediately reflect the new column placement.
      board = await readBoard(app, projectId);
      expect(columnCount(board, "Backlog")).toBe(0);
      expect(columnCount(board, "In Progress")).toBe(1);
      expect(issueInColumn(board, "Backlog", issueId)).toBe(false);
      expect(issueInColumn(board, "In Progress", issueId)).toBe(true);
    });

    it("reflects correct counts when multiple issues are PATCH'd across columns", async () => {
      const { app, db } = createApp();
      const repoPath = createTempGitRepo();
      const { projectId, statusIds, now } = await seedProject(db, repoPath, [
        { name: "Backlog", sortOrder: 0, isDefault: true },
        { name: "Done", sortOrder: 1 },
      ]);

      const issueIds = [randomUUID(), randomUUID(), randomUUID()];
      for (let n = 0; n < issueIds.length; n++) {
        await db.insert(schema.issues).values({
          id: issueIds[n],
          issueNumber: 10 + n,
          title: `Batch issue ${n}`,
          statusId: statusIds["Backlog"],
          projectId,
          skipAutoReview: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      let board = await readBoard(app, projectId);
      expect(columnCount(board, "Backlog")).toBe(3);
      expect(columnCount(board, "Done")).toBe(0);

      // PATCH all three to Done via HTTP.
      for (const id of issueIds) {
        const res = await app.request(`/api/issues/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusId: statusIds["Done"] }),
        });
        expect(res.status).toBe(200);
      }

      board = await readBoard(app, projectId);
      expect(columnCount(board, "Backlog")).toBe(0);
      expect(columnCount(board, "Done")).toBe(3);
    });
  });

  describe("2. Workspace merge → GET /board → issue moved to Done column", () => {
    it("reflects Done column after workspace_merged broadcast following a merge", async () => {
      // Uses the service layer directly — the production merge workflow does exactly
      // this: update issue statusId in DB, then broadcast workspace_merged to
      // invalidate the board cache. No git operations means no Windows file locks.
      const now = new Date().toISOString();
      const { db } = createTestDb();
      const boardEvents = createBoardEvents();
      const workspaceSummaryCache = createWorkspaceSummaryCache();
      boardEvents.addInvalidationListener((pid) => workspaceSummaryCache.invalidate(pid));
      const projectService = createProjectService({ database: db, workspaceSummaryCache });

      const projectId = randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        name: "Merge Invariant Test",
        repoPath: "/tmp/merge-invariant",
        repoName: "merge-invariant",
        defaultBranch: "main",
        createdAt: now,
        updatedAt: now,
      });

      const inReviewStatusId = randomUUID();
      await db.insert(schema.projectStatuses).values({
        id: inReviewStatusId,
        projectId,
        name: "In Review",
        sortOrder: 1,
        isDefault: false,
        createdAt: now,
      });

      const doneStatusId = randomUUID();
      await db.insert(schema.projectStatuses).values({
        id: doneStatusId,
        projectId,
        name: "Done",
        sortOrder: 2,
        isDefault: false,
        createdAt: now,
      });

      const issueId = randomUUID();
      await db.insert(schema.issues).values({
        id: issueId,
        issueNumber: 20,
        title: "Merge invariant issue",
        statusId: inReviewStatusId,
        projectId,
        skipAutoReview: true,
        createdAt: now,
        updatedAt: now,
      });

      // Warm the cache — issue is In Review.
      let board = await projectService.getBoard(projectId, now);
      expect(board.find((c) => c.name === "In Review")?.issues.some((i) => i.id === issueId)).toBe(true);
      expect(board.find((c) => c.name === "Done")?.issues.some((i) => i.id === issueId)).toBe(false);

      // Simulate merge: update DB status to Done, then broadcast workspace_merged
      // (this is what workspace-merge-execution.service does after a successful merge).
      await db.update(schema.issues).set({ statusId: doneStatusId }).where(eq(schema.issues.id, issueId));
      boardEvents.broadcast(projectId, "workspace_merged");

      // GET /board must now show issue in Done, not In Review.
      board = await projectService.getBoard(projectId, now);
      expect(board.find((c) => c.name === "In Review")?.issues.some((i) => i.id === issueId)).toBe(false);
      expect(board.find((c) => c.name === "Done")?.issues.some((i) => i.id === issueId)).toBe(true);

      // Column count invariant: Done count is 1, In Review count is 0.
      const doneCol = board.find((c) => c.name === "Done");
      const inReviewCol = board.find((c) => c.name === "In Review");
      expect(doneCol?.issues).toHaveLength(1);
      expect(inReviewCol?.issues).toHaveLength(0);
    });
  });

  describe("3. Workspace DELETE → GET /board → workspaceSummary removed", () => {
    it("removes workspaceSummary from issue after workspace is deleted via HTTP", async () => {
      const { app, db } = createApp();
      const repoPath = createTempGitRepo();
      const { projectId, statusIds, now } = await seedProject(db, repoPath, [
        { name: "Backlog", sortOrder: 0, isDefault: true },
        { name: "In Progress", sortOrder: 1 },
      ]);

      const issueId = randomUUID();
      await db.insert(schema.issues).values({
        id: issueId,
        issueNumber: 30,
        title: "Delete invariant issue",
        statusId: statusIds["Backlog"],
        projectId,
        skipAutoReview: true,
        createdAt: now,
        updatedAt: now,
      });

      // Board initially: no workspace, no workspaceSummary.
      let board = await readBoard(app, projectId);
      const issueBeforeCreate = board
        .find((c) => c.name === "Backlog")
        ?.issues.find((i) => i.id === issueId);
      expect(issueBeforeCreate).toBeDefined();
      expect(issueBeforeCreate?.workspaceSummary).toBeUndefined();

      // Create a direct workspace (no separate worktree directory — uses repoPath
      // in-place, so no additional git directories are created inside tmpdir).
      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, isDirect: true, skipSetup: true }),
      });
      expect(createRes.status).toBe(201);
      const workspace = (await createRes.json()) as { id: string };

      // Board after create: issue moved to In Progress with a workspaceSummary.
      board = await readBoard(app, projectId);
      const issueAfterCreate = board
        .find((c) => c.name === "In Progress")
        ?.issues.find((i) => i.id === issueId);
      expect(issueAfterCreate).toBeDefined();
      expect(issueAfterCreate?.workspaceSummary?.total).toBeGreaterThanOrEqual(1);

      // DELETE the workspace via HTTP.
      const deleteRes = await app.request(`/api/workspaces/${workspace.id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);

      // Board must reflect the deletion: the issue exists but has no workspace summary.
      board = await readBoard(app, projectId);
      const allIssues = board.flatMap((c) => c.issues);
      const issueAfterDelete = allIssues.find((i) => i.id === issueId);
      expect(issueAfterDelete).toBeDefined();
      expect(issueAfterDelete?.workspaceSummary).toBeUndefined();
    });
  });
});
