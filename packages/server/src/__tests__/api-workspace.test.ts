import { describe, it, expect, beforeAll } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TestDb } from "./helpers/test-db.js";
import {
  createTestApp,
  createTestAppWithBoardEvents,
  createProjectDirectly,
  createStatusDirectly,
} from "./helpers/api-test-helpers.js";

describe("Workspaces API", () => {
  const { app, db: database } = createTestApp();
  let issueId: string;
  let projectId: string;

  beforeAll(async () => {
    // Create project + status + issue
    projectId = await createProjectDirectly(database, { name: "Workspace Test Project" });
    const statusId = await createStatusDirectly(database, projectId, "Todo", 0);
    // Workspace creation moves the issue to In Progress transactionally and rolls the
    // whole create back if the status is missing — seed it like a real project has.
    await createStatusDirectly(database, projectId, "In Progress", 1);

    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "WS test issue", statusId, projectId }),
    });
    issueId = (await issueRes.json()).id;
  });

  it("POST /api/workspaces merge succeeds after registering a clean temporary repo", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-clean-main-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
      writeFileSync(join(repoPath, "README.md"), "initial\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoPath });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

      const projectRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath }),
      });
      expect(projectRes.status).toBe(201);
      const registeredProject = await projectRes.json() as any;

      const repoStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: repoPath,
        encoding: "utf8",
      });
      expect(repoStatus).toBe("");

      const mergeStatusId = await createStatusDirectly(database, registeredProject.id, "Todo", 0);
      const issueRes = await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Merge guard regression", statusId: mergeStatusId, projectId: registeredProject.id }),
      });
      const workspaceIssue = await issueRes.json() as any;

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: workspaceIssue.id, branch: "feature/clean-main-regression" }),
      });
      expect(createRes.status).toBe(201);
      const workspace = await createRes.json() as any;

      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspace.workingDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace.workingDir });
      writeFileSync(join(workspace.workingDir, "ticket.txt"), "done\n", "utf8");
      execFileSync("git", ["add", "ticket.txt"], { cwd: workspace.workingDir });
      execFileSync("git", ["commit", "-m", "feat: add workspace change"], { cwd: workspace.workingDir });

      const readyRes = await app.request(`/api/workspaces/${workspace.id}/ready-for-merge`, { method: "POST" });
      expect(readyRes.status).toBe(200);

      const mergeRes = await app.request(`/api/workspaces/${workspace.id}/merge`, { method: "POST" });
      expect(mergeRes.status).toBe(200);
      const mergeBody = await mergeRes.json() as any;
      expect(mergeBody.id).toBe(workspace.id);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("GET /api/projects/:id/board reflects Done counts immediately after workspace merge", { timeout: 30000 }, async () => {
    const { app, db } = createTestAppWithBoardEvents();
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-board-merge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
      writeFileSync(join(repoPath, "README.md"), "initial\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoPath });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

      const projectRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath }),
      });
      expect(projectRes.status).toBe(201);
      const registeredProject = await projectRes.json() as any;

      const statuses = await db
        .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
        .from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, registeredProject.id));
      const todoStatus = statuses.find((status) => status.name === "Todo");
      const inReviewStatus = statuses.find((status) => status.name === "In Review");
      const doneStatus = statuses.find((status) => status.name === "Done");
      expect(todoStatus).toBeDefined();
      expect(inReviewStatus).toBeDefined();
      expect(doneStatus).toBeDefined();

      const issueRes = await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Board merge count regression",
          statusId: todoStatus!.id,
          projectId: registeredProject.id,
        }),
      });
      expect(issueRes.status).toBe(201);
      const workspaceIssue = await issueRes.json() as any;

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: workspaceIssue.id, branch: "feature/board-merge-count-regression" }),
      });
      expect(createRes.status).toBe(201);
      const workspace = await createRes.json() as any;

      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspace.workingDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace.workingDir });
      writeFileSync(join(workspace.workingDir, "ticket.txt"), "done\n", "utf8");
      execFileSync("git", ["add", "ticket.txt"], { cwd: workspace.workingDir });
      execFileSync("git", ["commit", "-m", "feat: add workspace change"], { cwd: workspace.workingDir });

      const inReviewRes = await app.request(`/api/issues/${workspaceIssue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusId: inReviewStatus!.id }),
      });
      expect(inReviewRes.status).toBe(200);

      const warmRes = await app.request(`/api/projects/${registeredProject.id}/board`);
      expect(warmRes.status).toBe(200);
      const warmEtag = warmRes.headers.get("ETag");
      expect(warmEtag).toBeTruthy();
      const warmBoard = await warmRes.json() as any[];
      expect(warmBoard.find((column) => column.name === "In Review")?.issues.some((issue: any) => issue.id === workspaceIssue.id)).toBe(true);
      expect(warmBoard.find((column) => column.name === "Done")?.count).toBe(0);

      const readyRes = await app.request(`/api/workspaces/${workspace.id}/ready-for-merge`, { method: "POST" });
      expect(readyRes.status).toBe(200);

      const mergeRes = await app.request(`/api/workspaces/${workspace.id}/merge`, { method: "POST" });
      expect(mergeRes.status).toBe(200);

      const freshRes = await app.request(`/api/projects/${registeredProject.id}/board`, {
        headers: { "If-None-Match": warmEtag! },
      });
      expect(freshRes.status).toBe(200);
      const freshBoard = await freshRes.json() as any[];
      const freshInReview = freshBoard.find((column) => column.name === "In Review");
      const freshDone = freshBoard.find((column) => column.name === "Done");

      expect(freshInReview?.issues.some((issue: any) => issue.id === workspaceIssue.id)).toBe(false);
      expect(freshInReview?.count).toBe(0);
      expect(freshDone?.issues.some((issue: any) => issue.id === workspaceIssue.id)).toBe(true);
      expect(freshDone?.count).toBe(1);
      expect(freshDone?.issues).toHaveLength(1);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("POST /api/workspaces creates a workspace", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.branch).toBe("feature/test");
    expect(body.status).toBe("active");
    expect(body.id).toBeDefined();
  });

  it("POST /api/workspaces requires issueId (branch is optional — auto-generated when omitted)", async () => {
    // Missing issueId → 400
    const missingIssue = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature/no-issue" }),
    });
    expect(missingIssue.status).toBe(400);

    // issueId present, branch omitted → accepted (branch is auto-generated, #4ac61424),
    // not rejected as a 400. (The branch value itself depends on the project's git repo,
    // which isn't exercised here — only that the missing branch is no longer a 400.)
    const autoBranch = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });
    expect(autoBranch.status).toBe(201);
  });

  it("GET /api/workspaces surfaces the model column in the list projection (#819)", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/model-proj", model: "sonnet" }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await app.request(`/api/workspaces?issueId=${issueId}`);
    expect(listRes.status).toBe(200);
    const rows = await listRes.json() as Array<{ model?: string | null }>;
    // The bug: the list projection omitted `model` entirely, so the field was absent from every row
    // and the API reported null even when a builder launched with a real model. Assert the column is
    // now part of the projected shape (value plumbing is covered by provider-config-resolution tests).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((w) => "model" in w)).toBe(true);
    // mergedAt + isDirect must also be projected so agents can judge merge/landing state.
    expect(rows.every((w) => "mergedAt" in w)).toBe(true);
    expect(rows.every((w) => "isDirect" in w)).toBe(true);
  });

  it("POST /api/workspaces skips setup script for direct workspaces", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-direct-setup-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repoPath });
    const directProjectId = await createProjectDirectly(database, {
      name: "Direct Setup Project",
      repoPath,
      setupScript: "echo setup-ran> setup-ran.txt",
      setupBlocking: true,
      setupEnabled: true,
    });
    const directStatusId = await createStatusDirectly(database, directProjectId, "Todo", 0);
    await createStatusDirectly(database, directProjectId, "In Progress", 1);
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Direct setup test", statusId: directStatusId, projectId: directProjectId }),
    });
    const directIssueId = (await issueRes.json()).id;

    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: directIssueId, isDirect: true }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.isDirect).toBe(true);
    expect(body.workingDir).toBe(repoPath);
    expect(body.latestSetup.state).toBe("skipped");
    expect(body.latestSetup.command).toBe("echo setup-ran> setup-ran.txt");
    expect(existsSync(join(repoPath, "setup-ran.txt"))).toBe(false);
  });

  it("GET /api/issues/:id/workspaces includes the latest setup script status", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-setup-status-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repoPath });
    const setupProjectId = await createProjectDirectly(database, {
      name: "Setup Status Project",
      repoPath,
      setupScript: "echo setup stdout && echo setup stderr 1>&2",
      setupBlocking: true,
      setupEnabled: true,
    });
    const setupStatusId = await createStatusDirectly(database, setupProjectId, "Todo", 0);
    await createStatusDirectly(database, setupProjectId, "In Progress", 1);
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Setup status test", statusId: setupStatusId, projectId: setupProjectId }),
    });
    const setupIssueId = (await issueRes.json()).id;

    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: setupIssueId, branch: "feature/setup-status" }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json() as any;
    expect(createBody.latestSetup.state).toBe("success");
    expect(createBody.latestSetup.exitCode).toBe(0);

    const res = await app.request(`/api/issues/${setupIssueId}/workspaces`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body[0].latestSetup).toMatchObject({
      command: "echo setup stdout && echo setup stderr 1>&2",
      state: "success",
      exitCode: 0,
    });
    expect(body[0].latestSetup.durationMs).toEqual(expect.any(Number));
    expect(body[0].latestSetup.stdoutTail).toContain("setup stdout");
    expect(body[0].latestSetup.stderrTail).toContain("setup stderr");
  });

  it("GET /api/workspaces/:id returns workspace with issue info", async () => {
    // Create workspace
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/get-test" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.branch).toBe("feature/get-test");
    expect(body.issue.title).toBe("WS test issue");
  });

  it("GET /api/workspaces/:id returns 404 for missing workspace", async () => {
    const res = await app.request(`/api/workspaces/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/issues/:id/workspaces lists workspaces for an issue", async () => {
    const res = await app.request(`/api/issues/${issueId}/workspaces`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].branch).toBeDefined();
  });

  it("GET /api/workspaces?projectId= lists workspaces for a project", async () => {
    const res = await app.request(`/api/workspaces?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const ws = body[0];
    expect(ws.id).toBeDefined();
    expect(ws.issueId).toBeDefined();
    expect(ws.branch).toBeDefined();
    expect(ws.status).toBeDefined();
    expect("readyForMerge" in ws).toBe(true);
  });

  it("GET /api/workspaces without projectId returns 400", async () => {
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(400);
  });

  it("GET /api/workspaces?projectId= only returns workspaces for that project", async () => {
    const otherProjectId = await createProjectDirectly(database, { name: "Other Project" });
    const res = await app.request(`/api/workspaces?projectId=${otherProjectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(0);
  });

  it("PATCH /api/workspaces/:id updates status", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/patch-test" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "idle" }),
    });
    expect(res.status).toBe(200);

    // Verify
    const getRes = await app.request(`/api/workspaces/${id}`);
    const body = await getRes.json();
    expect(body.status).toBe("idle");
  });

  it("PATCH /api/workspaces/:id rejects invalid status", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/bad-status" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/workspaces/:id deletes a workspace", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/delete-test" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);

    // Verify gone
    const getRes = await app.request(`/api/workspaces/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("DELETE /api/workspaces/:id deletes all workspace FK children", async () => {
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/delete-fk-children" }),
    });
    const { id } = await createRes.json();
    const now = new Date().toISOString();
    const sessionId = randomUUID();

    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId: id,
      executor: "codex",
      status: "stopped",
      startedAt: now,
      endedAt: now,
    });
    await database.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data: "done",
      createdAt: now,
    });
    await database.insert(schema.diffComments).values({
      id: randomUUID(),
      workspaceId: id,
      filePath: "src/index.ts",
      side: "new",
      body: "delete me",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId,
      workspaceId: id,
      type: "text",
      content: "proof",
      createdAt: now,
    });
    await database.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId,
      workspaceId: id,
      kind: "note",
      author: "agent",
      body: "delete me",
      createdAt: now,
    });
    await database.insert(schema.repos).values({
      id: randomUUID(),
      workspaceId: id,
      path: "/tmp/delete-fk-children",
      name: "delete-fk-children",
      createdAt: now,
    });
    await database.insert(schema.testRetryDecisions).values({
      id: randomUUID(),
      sessionId,
      workspaceId: id,
      testName: "flaky test",
      decision: "flake",
      confidence: 0.9,
      retryCount: 1,
      finalOutcome: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workflowTransitions).values({
      id: randomUUID(),
      workspaceId: id,
      toNodeId: randomUUID(),
      summary: "delete me",
      triggeredBy: "agent",
      createdAt: now,
    });

    const res = await app.request(`/api/workspaces/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const workspaceRows = await database.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    const sessionRows = await database.select().from(schema.sessions).where(eq(schema.sessions.workspaceId, id));
    const messageRows = await database.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, sessionId));
    const diffCommentRows = await database.select().from(schema.diffComments).where(eq(schema.diffComments.workspaceId, id));
    const retryRows = await database.select().from(schema.testRetryDecisions).where(eq(schema.testRetryDecisions.workspaceId, id));
    const artifactRows = await database.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.workspaceId, id));
    const commentRows = await database.select().from(schema.issueComments).where(eq(schema.issueComments.workspaceId, id));
    const repoRows = await database.select().from(schema.repos).where(eq(schema.repos.workspaceId, id));
    const transitionRows = await database.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workspaceId, id));
    expect(workspaceRows).toHaveLength(0);
    expect(sessionRows).toHaveLength(0);
    expect(messageRows).toHaveLength(0);
    expect(diffCommentRows).toHaveLength(0);
    expect(retryRows).toHaveLength(0);
    expect(artifactRows).toHaveLength(0);
    expect(commentRows).toHaveLength(0);
    expect(repoRows).toHaveLength(0);
    expect(transitionRows).toHaveLength(0);
  });
});

