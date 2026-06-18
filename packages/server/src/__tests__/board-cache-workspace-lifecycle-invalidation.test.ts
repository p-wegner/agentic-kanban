import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectsRoute } from "../routes/projects.js";
import { createWorkspacesRoute } from "../routes/workspaces.js";
import { createBoardEvents } from "../services/board-events.js";

interface BoardIssue {
  id: string;
  statusName: string;
  workspaceSummary?: {
    total: number;
    active: number;
    idle: number;
    closed: number;
    main?: {
      id: string;
      branch: string;
      status: string;
    } | null;
  };
}

interface BoardColumn {
  name: string;
  issues: BoardIssue[];
}

const tempRepos: string[] = [];

afterEach(() => {
  for (const repoPath of tempRepos.splice(0)) {
    // Best-effort cleanup: Windows keeps git's pack/object files read-only and may briefly
    // hold a lock, which makes rmSync throw EPERM. Retry, and never let a temp-dir cleanup
    // failure fail the test itself.
    try {
      rmSync(repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* temp dir will be reaped by the OS */
    }
  }
});

function createApp() {
  const { db } = createTestDb();
  const boardEvents = createBoardEvents();
  const app = new Hono();
  app.route("/api/projects", createProjectsRoute(db, { boardEvents }));
  app.route("/api/workspaces", createWorkspacesRoute(db, undefined, { boardEvents }));
  return { app, db };
}

function createTempGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ak-board-cache-"));
  tempRepos.push(repoPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });
  return repoPath;
}

async function seedProjectWithBacklogIssue(db: TestDb, repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const backlogStatusId = randomUUID();
  const inProgressStatusId = randomUUID();
  const issueId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Workspace Lifecycle Cache Test",
    repoPath,
    repoName: "workspace-lifecycle-cache-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectStatuses).values([
    {
      id: backlogStatusId,
      projectId,
      name: "Backlog",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    },
    {
      id: inProgressStatusId,
      projectId,
      name: "In Progress",
      sortOrder: 1,
      isDefault: false,
      createdAt: now,
    },
  ]);

  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 683,
    title: "Backlog issue needing workspace",
    statusId: backlogStatusId,
    projectId,
    skipAutoReview: true,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId };
}

async function readBoard(app: Hono, projectId: string, etag?: string) {
  const res = await app.request(`/api/projects/${projectId}/board`, {
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  expect(res.status).toBe(200);
  return {
    etag: res.headers.get("etag") ?? undefined,
    board: (await res.json()) as BoardColumn[],
  };
}

function findIssue(board: BoardColumn[], statusName: string, issueId: string): BoardIssue {
  const column = board.find((c) => c.name === statusName);
  const issue = column?.issues.find((i) => i.id === issueId);
  if (!issue) {
    throw new Error(`Issue ${issueId} was not found in ${statusName}`);
  }
  return issue;
}

function expectIssueAbsent(board: BoardColumn[], statusName: string, issueId: string) {
  const column = board.find((c) => c.name === statusName);
  expect(column?.issues.some((i) => i.id === issueId)).toBe(false);
}

describe("board cache invalidation on workspace create/delete", () => {
  it("refreshes /api/projects/:id/board immediately after direct workspace create and delete", async () => {
    const { app, db } = createApp();
    const repoPath = createTempGitRepo();
    const { projectId, issueId } = await seedProjectWithBacklogIssue(db, repoPath);

    const warm = await readBoard(app, projectId);
    const backlogIssue = findIssue(warm.board, "Backlog", issueId);
    expect(backlogIssue.workspaceSummary).toBeUndefined();
    expectIssueAbsent(warm.board, "In Progress", issueId);

    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, isDirect: true, skipSetup: true }),
    });
    expect(createRes.status).toBe(201);
    const createdWorkspace = (await createRes.json()) as { id: string; branch: string };

    const afterCreate = await readBoard(app, projectId, warm.etag);
    expectIssueAbsent(afterCreate.board, "Backlog", issueId);
    const inProgressIssue = findIssue(afterCreate.board, "In Progress", issueId);
    expect(inProgressIssue.statusName).toBe("In Progress");
    expect(inProgressIssue.workspaceSummary).toMatchObject({
      total: 1,
      active: 1,
      idle: 0,
      closed: 0,
      main: {
        id: createdWorkspace.id,
        branch: "main",
        status: "active",
      },
    });

    const deleteRes = await app.request(`/api/workspaces/${createdWorkspace.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const afterDelete = await readBoard(app, projectId, afterCreate.etag);
    const issueAfterDelete = findIssue(afterDelete.board, "In Progress", issueId);
    expect(issueAfterDelete.workspaceSummary).toBeUndefined();
  });
});
