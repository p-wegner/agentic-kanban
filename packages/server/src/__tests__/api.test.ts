import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

// Helper: create a project directly in DB (bypassing git-info detection)
async function createProjectDirectly(database: TestDb, overrides: {
  name?: string;
  repoPath?: string;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
  defaultBranch?: string | null;
} = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name: overrides.name || "Test Project",
    repoPath: overrides.repoPath || "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: overrides.defaultBranch === undefined ? "main" : overrides.defaultBranch,
    setupScript: overrides.setupScript,
    setupBlocking: overrides.setupBlocking,
    setupEnabled: overrides.setupEnabled,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createStatusDirectly(database: TestDb, projectId: string, name: string, sortOrder: number) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    isDefault: sortOrder === 0,
    createdAt: now,
  });
  return id;
}

describe("Projects API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database);
  });

  it("GET /api/projects returns list", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].name).toBeDefined();
    expect(body[0].repoPath).toBeDefined();
  });

  it("GET /api/projects/:id/branches returns error for non-git path", async () => {
    const res = await app.request(`/api/projects/${projectId}/branches`);
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
  });

  it("GET /api/projects/:id/branches returns 404 for missing project", async () => {
    const res = await app.request(`/api/projects/${randomUUID()}/branches`);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/projects/:id validates defaultBranch exists locally", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-project-branch-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

    const gitProjectId = await createProjectDirectly(database, { repoPath, defaultBranch: null });
    try {
      const invalid = await app.request(`/api/projects/${gitProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "does-not-exist" }),
      });
      expect(invalid.status).toBe(400);

      const valid = await app.request(`/api/projects/${gitProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "main" }),
      });
      expect(valid.status).toBe(200);

      const rows = await database.select({ defaultBranch: schema.projects.defaultBranch }).from(schema.projects).where(eq(schema.projects.id, gitProjectId));
      expect(rows[0].defaultBranch).toBe("main");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("GET /api/projects/:id/stats includes code metrics and history", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "kanban-project-metrics-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Metrics Tester"], { cwd: repoPath });
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "src", "__tests__"), { recursive: true });
    writeFileSync(join(repoPath, "src", "feature.ts"), "export const value = 1;\nexport const next = 2;\n");
    writeFileSync(join(repoPath, "src", "__tests__", "feature.test.ts"), "import './feature';\nexpect(1).toBe(1);\n");
    execFileSync("git", ["add", "."], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "add code metrics fixture"], { cwd: repoPath });

    const gitProjectId = await createProjectDirectly(database, { repoPath, defaultBranch: "main" });
    try {
      const res = await app.request(`/api/projects/${gitProjectId}/stats`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;

      expect(body.codeMetrics.productionLoc).toBe(2);
      expect(body.codeMetrics.testLoc).toBe(2);
      expect(body.codeMetrics.testRatio).toBe(50);
      expect(body.history.weeks).toHaveLength(12);
      expect(body.history.contributorCount).toBe(1);
      expect(body.hotspots.some((file: any) => file.path === "src/feature.ts")).toBe(true);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("Issues API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Issue Test Project" });
    statusId = await createStatusDirectly(database, projectId, "Todo", 0);
  });

  it("POST /api/issues creates an issue", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test issue",
        priority: "high",
        statusId,
        projectId,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.title).toBe("Test issue");
  });

  it("GET /api/issues returns issues with statusName", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].statusName).toBe("Todo");
  });

  it("GET /api/issues requires projectId", async () => {
    const res = await app.request("/api/issues");
    expect(res.status).toBe(400);
  });

  it("PATCH /api/issues/:id updates an issue", async () => {
    // Create issue
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To update", statusId, projectId }),
    });
    const { id } = await createRes.json();

    // Update it
    const res = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title" }),
    });
    expect(res.status).toBe(200);

    // Verify
    const issues = await (
      await app.request(`/api/issues?projectId=${projectId}`)
    ).json();
    const updated = issues.find((i: { id: string }) => i.id === id);
    expect(updated.title).toBe("Updated title");
  });

  it("DELETE /api/issues/:id deletes an issue", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To delete", statusId, projectId }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/issues/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  it("DELETE /api/issues/:id removes incoming dependencies", async () => {
    const targetRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dependency target", statusId, projectId }),
    });
    const sourceRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dependency source", statusId, projectId }),
    });
    const target = await targetRes.json() as any;
    const source = await sourceRes.json() as any;

    await database.insert(schema.issueDependencies).values({
      id: randomUUID(),
      issueId: source.id,
      dependsOnId: target.id,
      type: "depends_on",
      createdAt: new Date().toISOString(),
    });

    const res = await app.request(`/api/issues/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const dependencyRows = await database
      .select()
      .from(schema.issueDependencies)
      .where(eq(schema.issueDependencies.dependsOnId, target.id));
    expect(dependencyRows).toHaveLength(0);
  });

  it("DELETE /api/issues/:id removes issue rows that also reference workspaces", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue with attachments", statusId, projectId }),
    });
    const issue = await createRes.json() as any;
    const now = new Date().toISOString();
    const showdownId = randomUUID();
    const workspaceId = randomUUID();

    await database.insert(schema.showdowns).values({
      id: showdownId,
      issueId: issue.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId: issue.id,
      branch: "feature/delete-attachments",
      showdownId,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId,
      type: "text",
      content: "proof",
      createdAt: now,
    });
    await database.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId: issue.id,
      workspaceId,
      kind: "note",
      author: "user",
      body: "delete me",
      createdAt: now,
    });

    const res = await app.request(`/api/issues/${issue.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const issueRows = await database.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
    const workspaceRows = await database.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    const artifactRows = await database.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issue.id));
    const commentRows = await database.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issue.id));
    const showdownRows = await database.select().from(schema.showdowns).where(eq(schema.showdowns.id, showdownId));
    expect(issueRows).toHaveLength(0);
    expect(workspaceRows).toHaveLength(0);
    expect(artifactRows).toHaveLength(0);
    expect(commentRows).toHaveLength(0);
    expect(showdownRows).toHaveLength(0);
  });

  it("POST /api/issues creates issue with estimate", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Estimated issue", statusId, projectId, estimate: "M" }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.estimate).toBe("M");
  });

  it("POST /api/issues defaults estimate to null", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No estimate", statusId, projectId }),
    });
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.estimate).toBeNull();
  });

  it("PATCH /api/issues/:id sets estimate", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch estimate", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const patchRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate: "XL" }),
    });
    expect(patchRes.status).toBe(200);

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const updated = list.find((i: any) => i.id === id);
    expect(updated.estimate).toBe("XL");
  });

  it("PATCH /api/issues/:id clears estimate", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Clear estimate", statusId, projectId, estimate: "S" }),
    });
    const { id } = await createRes.json() as any;

    await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate: null }),
    });

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const updated = list.find((i: any) => i.id === id);
    expect(updated.estimate).toBeNull();
  });

  it("GET /api/issues returns estimate field", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "With estimate", statusId, projectId, estimate: "XS" }),
    });
    const { id } = await createRes.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const issue = list.find((i: any) => i.id === id);
    expect(issue).toHaveProperty("estimate");
    expect(issue.estimate).toBe("XS");
  });

  it("POST /api/issues persists externalKey and externalUrl", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Linked issue",
        statusId,
        projectId,
        externalKey: "PROJ-123",
        externalUrl: "https://tracker.example.com/browse/PROJ-123",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.externalKey).toBe("PROJ-123");
    expect(created.externalUrl).toBe("https://tracker.example.com/browse/PROJ-123");
  });

  it("POST /api/issues defaults external fields to null", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No external link", statusId, projectId }),
    });
    const { id } = await res.json() as any;

    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const created = list.find((i: any) => i.id === id);
    expect(created.externalKey).toBeNull();
    expect(created.externalUrl).toBeNull();
  });

  it("POST /api/issues rejects a non-http externalUrl", async () => {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bad link",
        statusId,
        projectId,
        externalUrl: "javascript:alert(1)",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/issues/:id sets and clears external fields", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch external", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const patchRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalKey: "LIN-7", externalUrl: "http://linear.app/issue/LIN-7" }),
    });
    expect(patchRes.status).toBe(200);

    let list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    let updated = list.find((i: any) => i.id === id);
    expect(updated.externalKey).toBe("LIN-7");
    expect(updated.externalUrl).toBe("http://linear.app/issue/LIN-7");

    const clearRes = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalKey: "", externalUrl: null }),
    });
    expect(clearRes.status).toBe(200);

    list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    updated = list.find((i: any) => i.id === id);
    expect(updated.externalKey).toBeNull();
    expect(updated.externalUrl).toBeNull();
  });

  it("PATCH /api/issues/:id rejects a non-http externalUrl", async () => {
    const createRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patch bad link", statusId, projectId }),
    });
    const { id } = await createRes.json() as any;

    const res = await app.request(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalUrl: "ftp://example.com/file" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Board API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Board Test Project" });
    todoStatusId = await createStatusDirectly(database, projectId, "Todo", 0);
    doneStatusId = await createStatusDirectly(database, projectId, "Done", 1);

    // Create issues in each status
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task 1", statusId: todoStatusId, projectId }),
    });
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task 2", statusId: doneStatusId, projectId }),
    });
  });

  it("GET /api/projects/:id/board returns statuses with nested issues", async () => {
    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.length).toBe(2);
    expect(body[0].name).toBe("Todo");
    expect(body[0].issues.length).toBe(1);
    expect(body[0].issues[0].title).toBe("Task 1");
    expect(body[0].issues[0].statusName).toBe("Todo");
    expect(body[1].name).toBe("Done");
    expect(body[1].issues.length).toBe(1);
  });

  it("GET /api/projects/:id/board exposes external tracker fields on issues", async () => {
    const linkProjectId = await createProjectDirectly(database, { name: "Board External Link Project" });
    const linkStatusId = await createStatusDirectly(database, linkProjectId, "Todo", 0);
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Linked task",
        statusId: linkStatusId,
        projectId: linkProjectId,
        externalKey: "GH-9",
        externalUrl: "https://github.com/acme/repo/issues/9",
      }),
    });

    const res = await app.request(`/api/projects/${linkProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const issue = body[0].issues[0];
    expect(issue.externalKey).toBe("GH-9");
    expect(issue.externalUrl).toBe("https://github.com/acme/repo/issues/9");
  });

  it("GET /api/projects/:id/board derives the column from active workflow progress", async () => {
    const workflowProjectId = await createProjectDirectly(database, { name: "Workflow Board Project" });
    const inProgressStatusId = await createStatusDirectly(database, workflowProjectId, "In Progress", 0);
    const inReviewStatusId = await createStatusDirectly(database, workflowProjectId, "In Review", 1);
    const now = new Date().toISOString();
    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();
    await database.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId: workflowProjectId,
      name: "Implement Review",
      isDefault: false,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workflowNodes).values([
      {
        id: implementNodeId,
        templateId,
        name: "Implement",
        nodeType: "normal",
        statusName: "In Progress",
        sortOrder: 0,
        createdAt: now,
      },
      {
        id: reviewNodeId,
        templateId,
        name: "Review",
        nodeType: "normal",
        statusName: "In Review",
        sortOrder: 1,
        createdAt: now,
      },
    ] as any);

    const issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      projectId: workflowProjectId,
      statusId: inProgressStatusId,
      issueNumber: 244,
      title: "Workflow status drift",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      workflowTemplateId: templateId,
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/workflow-status-drift",
      status: "idle",
      currentNodeId: reviewNodeId,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/projects/${workflowProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.find((column: any) => column.name === "In Progress")?.issues).toHaveLength(0);
    expect(body.find((column: any) => column.name === "In Review")?.issues[0]).toMatchObject({
      id: issueId,
      statusId: inReviewStatusId,
      statusName: "In Review",
    });
  });

  it("GET /api/projects/:id/board includes latest workspace session status and assistant message", async () => {
    const sessionProjectId = await createProjectDirectly(database, { name: "Board Session Project" });
    const statusId = await createStatusDirectly(database, sessionProjectId, "In Progress", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: sessionProjectId,
      statusId,
      issueNumber: 253,
      title: "Surface session state",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/session-state-summary",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: now,
      triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I found the missing board fields." },
      }),
      createdAt: now,
    });

    const res = await app.request(`/api/projects/${sessionProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((column: any) => column.issues);
    const issue = allIssues.find((item: any) => item.id === issueId);

    expect(issue.workspaceSummary.main).toMatchObject({
      id: workspaceId,
      status: "active",
      sessionStatus: "running",
      lastSessionTriggerType: "initial",
      lastAssistantMessage: "I found the missing board fields.",
    });
  });

  it("GET /api/projects/:id/board includes main workspace workingDir", async () => {
    const workspaceProjectId = await createProjectDirectly(database, {
      name: "Workspace Summary Board Project",
      defaultBranch: null,
    });
    const inProgressStatusId = await createStatusDirectly(database, workspaceProjectId, "In Progress", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const workingDir = "C:/andrena/.worktrees/feature_ak-249-board-working-dir";

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: workspaceProjectId,
      statusId: inProgressStatusId,
      issueNumber: 249,
      title: "Expose workspace workingDir",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-249-board-working-dir",
      workingDir,
      status: "reviewing",
      isDirect: true,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/projects/${workspaceProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const issue = body.flatMap((column: any) => column.issues).find((item: any) => item.id === issueId);

    expect(issue.workspaceSummary.main).toMatchObject({
      id: workspaceId,
      branch: "feature/ak-249-board-working-dir",
      status: "reviewing",
      workingDir,
    });
  });

  it("GET /api/projects/:id/board returns 404 for missing project", async () => {
    const res = await app.request(`/api/projects/${randomUUID()}/board`);
    expect(res.status).toBe(404);
  });
});

describe("Workspaces API", () => {
  const { app, db: database } = createTestApp();
  let issueId: string;
  let projectId: string;

  beforeAll(async () => {
    // Create project + status + issue
    projectId = await createProjectDirectly(database, { name: "Workspace Test Project" });
    const statusId = await createStatusDirectly(database, projectId, "Todo", 0);

    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "WS test issue", statusId, projectId }),
    });
    issueId = (await issueRes.json()).id;
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

  it("POST /api/workspaces requires issueId and branch", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });
    expect(res.status).toBe(400);
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
});

describe("Diff Comments API", () => {
  const { app, db: database } = createTestApp();
  let workspaceId: string;

  beforeAll(async () => {
    const projectId = await createProjectDirectly(database, { name: "Comments Test Project" });
    const statusId = await createStatusDirectly(database, projectId, "Todo", 0);

    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Comment test issue", statusId, projectId }),
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/comments" }),
    });
    workspaceId = (await wsRes.json()).id;
  });

  it("POST creates a comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: "src/index.ts",
        lineNumNew: 10,
        side: "new",
        body: "Looks good",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.filePath).toBe("src/index.ts");
    expect(body.body).toBe("Looks good");
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.id).toBeDefined();
  });

  it("POST requires filePath and body", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineNumNew: 5 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("filePath and body are required");
  });

  it("POST returns 404 for missing workspace", async () => {
    const res = await app.request(`/api/workspaces/${randomUUID()}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "a.ts", body: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET lists comments for workspace", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].filePath).toBeDefined();
  });

  it("GET filters by filePath", async () => {
    // Create another comment on a different file
    await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "src/other.ts", body: "Another comment" }),
    });

    const res = await app.request(`/api/workspaces/${workspaceId}/comments?filePath=src/index.ts`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.every((c: { filePath: string }) => c.filePath === "src/index.ts")).toBe(true);
  });

  it("PATCH updates a comment", async () => {
    // Create a comment
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "a.ts", body: "Original" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(id);

    // Verify update
    const comments = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    const updated = comments.find((c: { id: string }) => c.id === id);
    expect(updated.body).toBe("Updated");
  });

  it("PATCH requires body", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE removes a comment", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "b.ts", body: "To delete" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);

    // Verify gone
    const comments = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    expect(comments.find((c: { id: string }) => c.id === id)).toBeUndefined();
  });

  it("DELETE returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("POST creates an unresolved comment by default", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "default state" }),
    });
    const body = await res.json() as any;
    expect(body.resolvedAt).toBeNull();
  });

  it("PATCH resolve marks a comment resolved, then reopens it", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "Please fix" }),
    });
    const { id } = await createRes.json();

    // Resolve
    const resolveRes = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = await resolveRes.json() as any;
    expect(resolved.id).toBe(id);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(typeof resolved.resolvedAt).toBe("string");

    // Verify persisted via GET
    const listed = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    expect(listed.find((c: { id: string }) => c.id === id).resolvedAt).not.toBeNull();

    // Reopen
    const reopenRes = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: false }),
    });
    expect(reopenRes.status).toBe(200);
    const reopened = await reopenRes.json() as any;
    expect(reopened.resolvedAt).toBeNull();
  });

  it("PATCH resolve requires a boolean resolved field", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "resolve.ts", body: "missing flag" }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${id}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH resolve returns 404 for missing comment", async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/comments/${randomUUID()}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    expect(res.status).toBe(404);
  });

  it("GET lists carry the resolvedAt field for each comment", async () => {
    const createRes = await app.request(`/api/workspaces/${workspaceId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "list-state.ts", body: "has resolvedAt" }),
    });
    const { id } = await createRes.json();

    const listed = await (await app.request(`/api/workspaces/${workspaceId}/comments`)).json();
    const found = listed.find((c: { id: string }) => c.id === id);
    expect(found).toBeDefined();
    expect(found).toHaveProperty("resolvedAt");
    expect(found.resolvedAt).toBeNull();
  });
});

describe("Preferences API", () => {
  const { app } = createTestApp();

  it("GET /api/preferences/active-project returns null initially", async () => {
    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBeNull();
  });

  it("PUT /api/preferences/active-project sets active project", async () => {
    const id = randomUUID();
    const res = await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBe(id);
  });

  it("GET /api/preferences/active-project returns set value", async () => {
    const id = randomUUID();
    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });

    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBe(id);
  });

  it("PUT upserts the preference", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id1 }),
    });

    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id2 }),
    });

    const res = await app.request("/api/preferences/active-project");
    const body = await res.json() as any;
    expect(body.projectId).toBe(id2);
  });
});

describe("Agent Skills API", () => {
  const { app } = createTestApp();

  it("POST /api/agent-skills creates a skill", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-skill",
        description: "A test skill",
        prompt: "You are a test agent. Do X, Y, Z.",
        model: "haiku",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("test-skill");
    expect(body.description).toBe("A test skill");
    expect(body.prompt).toBe("You are a test agent. Do X, Y, Z.");
    expect(body.model).toBe("haiku");
    expect(body.isBuiltin).toBe(false);
  });

  it("GET /api/agent-skills lists all skills", async () => {
    const res = await app.request("/api/agent-skills");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBeGreaterThanOrEqual(1);
    const names = body.map((s: any) => s.name);
    expect(names).toContain("test-skill");
  });

  it("GET /api/agent-skills/:id returns a skill", async () => {
    const listRes = await app.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const skill = skills.find((s: any) => s.name === "test-skill");

    const res = await app.request(`/api/agent-skills/${skill.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(skill.id);
    expect(body.prompt).toBe("You are a test agent. Do X, Y, Z.");
  });

  it("POST /api/agent-skills rejects duplicate name", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-skill",
        description: "Duplicate",
        prompt: "dup",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/agent-skills validates required fields", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "incomplete" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/agent-skills/:id updates a skill", async () => {
    const listRes = await app.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const skill = skills.find((s: any) => s.name === "test-skill");

    const res = await app.request(`/api/agent-skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.description).toBe("Updated description");
  });

  it("DELETE /api/agent-skills/:id deletes a skill", async () => {
    // Create a skill to delete
    const createRes = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        description: "Will be deleted",
        prompt: "delete me",
      }),
    });
    const { id } = await createRes.json() as any;

    const res = await app.request(`/api/agent-skills/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const getRes = await app.request(`/api/agent-skills/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("protects builtin skills from modification", async () => {
    // Create a builtin skill directly in DB
    const { app: app2, db: database } = createTestApp();
    const { agentSkills } = await import("@agentic-kanban/shared/schema");
    const now = new Date().toISOString();
    await database.insert(agentSkills).values({
      id: randomUUID(),
      name: "builtin-skill",
      description: "Builtin",
      prompt: "builtin prompt",
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });

    const listRes = await app2.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const builtin = skills.find((s: any) => s.name === "builtin-skill");

    // PUT should fail
    const putRes = await app2.request(`/api/agent-skills/${builtin.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "hacked" }),
    });
    expect(putRes.status).toBe(403);

    // DELETE should fail
    const delRes = await app2.request(`/api/agent-skills/${builtin.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(403);
  });
});

describe("Transcript Search API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Transcript Search Project" });
    statusId = await createStatusDirectly(database, projectId, "In Progress", 0);
  });

  async function seedSession(overrides: {
    issueTitle: string;
    branch: string;
    executor?: string;
    statusName?: string;
    messages: { type: string; data: string }[];
  }) {
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    // Optionally create a separate status for this issue
    let sid = statusId;
    if (overrides.statusName && overrides.statusName !== "In Progress") {
      sid = await createStatusDirectly(database, projectId, overrides.statusName, 10);
    }

    await database.insert(schema.issues).values({
      id: issueId,
      projectId,
      statusId: sid,
      issueNumber: Math.floor(Math.random() * 9000) + 1000,
      title: overrides.issueTitle,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: overrides.branch,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: overrides.executor ?? "claude-code",
      status: "completed",
      startedAt: now,
    });
    for (const msg of overrides.messages) {
      await database.insert(schema.sessionMessages).values({
        sessionId,
        type: msg.type,
        data: msg.data,
        createdAt: now,
      });
    }
    return { issueId, workspaceId, sessionId };
  }

  it("returns matching results for a search query", async () => {
    await seedSession({
      issueTitle: "Fix auth bug",
      branch: "feature/auth-fix",
      messages: [
        { type: "stdout", data: "Error: Cannot read property 'token' of undefined at AuthService" },
        { type: "stdout", data: "Fixed by adding null check in auth middleware" },
      ],
    });

    const res = await app.request(`/api/sessions/search?q=token&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].snippet).toContain("token");
    expect(body.results[0].issueTitle).toBe("Fix auth bug");
    expect(body.results[0].branch).toBe("feature/auth-fix");
    expect(body.results[0].projectId).toBe(projectId);
    expect(body.results[0].projectName).toBe("Transcript Search Project");
    expect(body.results[0].executor).toBe("claude-code");
  });

  it("returns empty results for non-matching query", async () => {
    const res = await app.request(`/api/sessions/search?q=zzzznonexistent&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("searches globally when projectId is omitted", async () => {
    const otherProjectId = await createProjectDirectly(database, { name: "Other Transcript Project" });
    const otherStatusId = await createStatusDirectly(database, otherProjectId, "Done", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: otherProjectId,
      statusId: otherStatusId,
      issueNumber: 287,
      title: "Implemented elsewhere",
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-287",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "completed",
      startedAt: now,
    });
    await database.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data: "GlobalNeedle implementation notes and problems",
      createdAt: now,
    });

    const res = await app.request("/api/sessions/search?q=GlobalNeedle");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      sessionId,
      projectId: otherProjectId,
      projectName: "Other Transcript Project",
      issueNumber: 287,
      issueTitle: "Implemented elsewhere",
    });
  });

  it("returns empty for query shorter than 2 chars", async () => {
    const res = await app.request(`/api/sessions/search?q=a&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("filters by status", async () => {
    const doneStatusId = await createStatusDirectly(database, projectId, "Done", 20);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId, projectId, statusId: doneStatusId,
      issueNumber: 8888, title: "Completed task", priority: "medium", issueType: "task",
      sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId, issueId, branch: "feature/done-task",
      status: "closed", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId, workspaceId, executor: "claude-code",
      status: "completed", startedAt: now,
    });
    await database.insert(schema.sessionMessages).values({
      sessionId, type: "stdout",
      data: "Searching for token in completed task",
      createdAt: now,
    });

    // Filter by "Done" — should match
    const doneRes = await app.request(`/api/sessions/search?q=token&projectId=${projectId}&status=Done`);
    expect(doneRes.status).toBe(200);
    const doneBody = await doneRes.json() as any;
    expect(doneBody.results.some((r: any) => r.issueTitle === "Completed task")).toBe(true);

    // Filter by "In Progress" — should NOT match the done issue
    const activeRes = await app.request(`/api/sessions/search?q=token&projectId=${projectId}&status=In Progress`);
    expect(activeRes.status).toBe(200);
    const activeBody = await activeRes.json() as any;
    expect(activeBody.results.some((r: any) => r.issueTitle === "Completed task")).toBe(false);
  });

  it("filters by provider", async () => {
    await seedSession({
      issueTitle: "Codex search test",
      branch: "feature/codex-test",
      executor: "codex",
      messages: [
        { type: "stdout", data: "Codex found the authentication error" },
      ],
    });

    // Filter by codex
    const codexRes = await app.request(`/api/sessions/search?q=authentication&projectId=${projectId}&provider=codex`);
    expect(codexRes.status).toBe(200);
    const codexBody = await codexRes.json() as any;
    expect(codexBody.results.length).toBeGreaterThanOrEqual(1);
    expect(codexBody.results.every((r: any) => r.executor === "codex")).toBe(true);
  });

  it("respects limit parameter", async () => {
    // Seed 3 sessions with the same keyword
    for (let i = 0; i < 3; i++) {
      await seedSession({
        issueTitle: `Limit test ${i}`,
        branch: `feature/limit-${i}`,
        messages: [
          { type: "stdout", data: `UniqueLimitKeyword found in result ${i}` },
        ],
      });
    }

    const res = await app.request(`/api/sessions/search?q=UniqueLimitKeyword&projectId=${projectId}&limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results.length).toBe(2);
  });
});
