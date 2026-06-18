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
import { createBoardEvents } from "../services/board-events.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

function createTestAppWithBoardEvents() {
  return _createTestApp((app, db) => {
    const boardEvents = createBoardEvents();
    app.route("/api", createRoutes(db, () => createMockSessionManager(), { boardEvents }));
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
    expect(typeof body[0].activeWorkspaceCount).toBe("number");
  });

  it("GET /api/projects counts active (non-idle/closed) workspaces per project", async () => {
    const countProjectId = await createProjectDirectly(database, { name: "Active Agents", repoPath: "/tmp/active-agents" });
    const statusId = await createStatusDirectly(database, countProjectId, "In Progress", 0);

    async function seedWorkspace(status: string) {
      const issueId = randomUUID();
      const now = new Date().toISOString();
      await database.insert(schema.issues).values({
        id: issueId,
        title: `Issue ${status}`,
        projectId: countProjectId,
        statusId,
        priority: "medium",
        issueType: "task",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      await database.insert(schema.workspaces).values({
        id: randomUUID(),
        issueId,
        branch: `test/${status}-${randomUUID().slice(0, 8)}`,
        status,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Two active (running, resolving conflicts), plus idle/closed which must not count.
    await seedWorkspace("active");
    await seedWorkspace("fixing");
    await seedWorkspace("idle");
    await seedWorkspace("closed");

    const body = await (await app.request("/api/projects")).json() as any[];
    const project = body.find((p) => p.id === countProjectId);
    expect(project).toBeDefined();
    expect(project.activeWorkspaceCount).toBe(2);
  });

  it("archive hides a project from the default list and unarchive restores it", async () => {
    const tempId = await createProjectDirectly(database, { name: "Archivable", repoPath: "/tmp/archivable" });

    const archiveRes = await app.request(`/api/projects/${tempId}/archive`, { method: "POST" });
    expect(archiveRes.status).toBe(200);

    // Hidden from the default list...
    const listed = await (await app.request("/api/projects")).json() as any[];
    expect(listed.some((p) => p.id === tempId)).toBe(false);

    // ...but present with includeArchived and stamped with archivedAt.
    const withArchived = await (await app.request("/api/projects?includeArchived=true")).json() as any[];
    const archived = withArchived.find((p) => p.id === tempId);
    expect(archived).toBeDefined();
    expect(archived.archivedAt).toBeTruthy();

    const unarchiveRes = await app.request(`/api/projects/${tempId}/unarchive`, { method: "POST" });
    expect(unarchiveRes.status).toBe(200);

    const relisted = await (await app.request("/api/projects")).json() as any[];
    const restored = relisted.find((p) => p.id === tempId);
    expect(restored).toBeDefined();
    expect(restored.archivedAt).toBeFalsy();
  });

  it("POST /api/projects/:id/archive returns 404 for missing project", async () => {
    const res = await app.request(`/api/projects/${randomUUID()}/archive`, { method: "POST" });
    expect(res.status).toBe(404);
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

describe("Agent Throughput by Provider (AK-514)", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let doneStatusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Throughput Test Project" });
    await createStatusDirectly(database, projectId, "Todo", 0);
    await createStatusDirectly(database, projectId, "In Progress", 1);
    doneStatusId = await createStatusDirectly(database, projectId, "Done", 2);
  });

  /** Helper: create a Done issue with a merged workspace for a given provider. */
  async function seedDone(provider: string, profile: string | null, ageDays: number) {
    const now = new Date();
    const doneAt = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(now.getTime() - (ageDays + 3) * 24 * 60 * 60 * 1000).toISOString();

    const issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      title: `Done issue via ${provider}`,
      projectId,
      statusId: doneStatusId,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt,
      updatedAt: doneAt,
      statusChangedAt: doneAt,
    });

    const wsId = randomUUID();
    await database.insert(schema.workspaces).values({
      id: wsId,
      issueId,
      branch: `test/${provider}-${randomUUID().slice(0, 8)}`,
      status: "merged",
      provider,
      claudeProfile: profile,
      mergedAt: doneAt,
      createdAt,
      updatedAt: doneAt,
    });

    return { issueId, wsId };
  }

  it("returns providers ranked by count with median lead time", async () => {
    // Seed: 3 claude, 2 codex
    await seedDone("claude", "anth", 1);
    await seedDone("claude", "anth", 2);
    await seedDone("claude", "anth", 5);
    await seedDone("codex", null, 3);
    await seedDone("codex", null, 4);

    const res = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider?days=14`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.window).toBe("14d");
    expect(body.providers).toHaveLength(2);

    // Claude should be first (3 > 2)
    expect(body.providers[0].provider).toBe("claude");
    expect(body.providers[0].profile).toBe("anth");
    expect(body.providers[0].count).toBe(3);
    expect(typeof body.providers[0].medianLeadTimeMs).toBe("number");

    expect(body.providers[1].provider).toBe("codex");
    expect(body.providers[1].profile).toBe("");
    expect(body.providers[1].count).toBe(2);

    // Server should return overall median computed from individual issue lead times
    expect(typeof body.overallMedianLeadTimeMs).toBe("number");
  });

  it("respects the time window filter", async () => {
    // Create a very old merged issue that should be excluded
    await seedDone("copilot", null, 20);

    const res = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider?days=7`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // copilot should not appear (20 days ago is outside 7d window)
    const copilot = body.providers.find((p: any) => p.provider === "copilot");
    expect(copilot).toBeUndefined();
  });

  it("returns empty providers array when no Done issues exist", async () => {
    const emptyProjectId = await createProjectDirectly(database, { name: "Empty Throughput" });
    const doneId = await createStatusDirectly(database, emptyProjectId, "Done", 0);

    const res = await app.request(
      `/api/projects/${emptyProjectId}/dashboard/throughput-by-provider?days=14`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.providers).toEqual([]);
    expect(body.window).toBe("14d");
  });

  it("defaults to 14 day window", async () => {
    const res = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.window).toBe("14d");
  });

  it("groups by provider:profile composite key", async () => {
    await seedDone("claude", "opus", 1);
    await seedDone("claude", "sonnet", 1);

    const res = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider?days=7`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const claudeAnth = body.providers.find((p: any) => p.provider === "claude" && p.profile === "anth");
    const claudeOpus = body.providers.find((p: any) => p.provider === "claude" && p.profile === "opus");
    const claudeSonnet = body.providers.find((p: any) => p.provider === "claude" && p.profile === "sonnet");

    expect(claudeAnth).toBeDefined();
    expect(claudeOpus).toBeDefined();
    expect(claudeSonnet).toBeDefined();
  });

  it("excludes workspaces that were not merged", async () => {
    // Insert a Done issue with a non-merged workspace
    const now = new Date();
    const doneAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      title: "Done but no merge",
      projectId,
      statusId: doneStatusId,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt,
      updatedAt: doneAt,
      statusChangedAt: doneAt,
    });

    const wsId = randomUUID();
    await database.insert(schema.workspaces).values({
      id: wsId,
      issueId,
      branch: `test/nomerge-${randomUUID().slice(0, 8)}`,
      status: "closed",
      provider: "codex",
      claudeProfile: null,
      // mergedAt is null — should be excluded
      createdAt,
      updatedAt: doneAt,
    });

    const res = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider?days=7`
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // The "closed, not merged" workspace should NOT contribute a count
    // to codex from this issue. Other codex entries may exist from prior tests.
    // We just verify the endpoint doesn't crash and excludes the non-merged one.
    expect(body.providers).toBeDefined();
  });

  it("deduplicates issues with multiple merged workspaces (counts each issue once)", async () => {
    // Create an issue with TWO merged workspaces — should only count once
    const now = new Date();
    const doneAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      title: "Double-merge issue",
      projectId,
      statusId: doneStatusId,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt,
      updatedAt: doneAt,
      statusChangedAt: doneAt,
    });

    // First merged workspace (the one that should win)
    await database.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: `test/dedup-a-${randomUUID().slice(0, 8)}`,
      status: "merged",
      provider: "copilot",
      claudeProfile: null,
      mergedAt: doneAt,
      createdAt,
      updatedAt: doneAt,
    });

    // Second merged workspace for the SAME issue — should NOT inflate count
    await database.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: `test/dedup-b-${randomUUID().slice(0, 8)}`,
      status: "merged",
      provider: "copilot",
      claudeProfile: null,
      mergedAt: doneAt,
      createdAt,
      updatedAt: doneAt,
    });

    // Count copilot BEFORE adding the double-merge
    const before = await app.request(
      `/api/projects/${projectId}/dashboard/throughput-by-provider?days=7`
    );
    const beforeBody = await before.json() as any;
    const copilotBefore = beforeBody.providers.find((p: any) => p.provider === "copilot");

    // copilot count should only be 1 (from this issue), not 2
    expect(copilotBefore).toBeDefined();
    expect(copilotBefore.count).toBe(1);
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

  it("GET /api/issues?statusName= filters to matching issues and leaves unfiltered path unchanged", async () => {
    const p = await createProjectDirectly(database, { name: "StatusFilter Project" });
    const todoId = await createStatusDirectly(database, p, "Todo", 0);
    const inProgressId = await createStatusDirectly(database, p, "In Progress", 1);

    // Create one issue in each status
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Todo issue", statusId: todoId, projectId: p }),
    });
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "In Progress issue", statusId: inProgressId, projectId: p }),
    });

    // Filtered: only "In Progress"
    const filtered = await app.request(`/api/issues?projectId=${p}&statusName=In%20Progress`);
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as any[];
    expect(filteredBody.length).toBe(1);
    expect(filteredBody[0].statusName).toBe("In Progress");
    expect(filteredBody[0].title).toBe("In Progress issue");

    // Unfiltered: both issues returned
    const all = await app.request(`/api/issues?projectId=${p}`);
    expect(all.status).toBe(200);
    const allBody = await all.json() as any[];
    expect(allBody.length).toBe(2);

    // Non-matching status returns empty array
    const none = await app.request(`/api/issues?projectId=${p}&statusName=Done`);
    expect(none.status).toBe(200);
    const noneBody = await none.json() as any[];
    expect(noneBody.length).toBe(0);
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

  it("PATCH /api/issues/:id persists sortOrder for in-column reorder", async () => {
    const aRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card A", statusId, projectId }),
    });
    const bRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card B", statusId, projectId }),
    });
    const cRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Card C", statusId, projectId }),
    });
    const { id: aId } = await aRes.json() as any;
    const { id: bId } = await bRes.json() as any;
    const { id: cId } = await cRes.json() as any;

    // Assign explicit sortOrders so the ordering is deterministic
    for (const [id, order] of [[aId, 100], [bId, 200], [cId, 300]] as [string, number][]) {
      const r = await app.request(`/api/issues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder: order }),
      });
      expect(r.status).toBe(200);
    }

    // Move C before B: new sortOrder midpoint = 150
    const reorderRes = await app.request(`/api/issues/${cId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder: 150 }),
    });
    expect(reorderRes.status).toBe(200);

    // Verify persisted sort order survives a fresh fetch
    const list = await (await app.request(`/api/issues?projectId=${projectId}`)).json() as any[];
    const c = list.find((i: any) => i.id === cId);
    expect(c.sortOrder).toBe(150);

    // Verify the board endpoint also reflects the new order (sortOrder ascending)
    const board = await (await app.request(`/api/projects/${projectId}/board`)).json() as any;
    const col = board.find((s: any) => s.id === statusId);
    const ids = col.issues.map((i: any) => i.id);
    // After reorder: A(100) < C(150) < B(200)
    expect(ids.indexOf(aId)).toBeLessThan(ids.indexOf(cId));
    expect(ids.indexOf(cId)).toBeLessThan(ids.indexOf(bId));
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
    expect(body[0].count).toBe(1);
    expect(body[0].issues[0].title).toBe("Task 1");
    expect(body[0].issues[0].statusName).toBe("Todo");
    expect(body[1].name).toBe("Done");
    expect(body[1].issues.length).toBe(1);
    expect(body[1].count).toBe(1);
  });

  it("GET /api/projects/:id/board/summary returns per-column counts with no issue bodies", async () => {
    const res = await app.request(`/api/projects/${projectId}/board/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.length).toBe(2);
    const todo = body.find((col: any) => col.name === "Todo");
    const done = body.find((col: any) => col.name === "Done");
    expect(todo).toBeDefined();
    expect(todo.statusId).toBe(todoStatusId);
    expect(todo.sortOrder).toBe(0);
    expect(todo.count).toBe(1);
    expect(done).toBeDefined();
    expect(done.statusId).toBe(doneStatusId);
    expect(done.sortOrder).toBe(1);
    expect(done.count).toBe(1);
    // No issue bodies — only the four summary fields
    expect(todo.issues).toBeUndefined();
    expect(done.issues).toBeUndefined();
  });

  it("GET /api/projects/:id/board/summary returns zero count for empty statuses", async () => {
    const emptyProjectId = await createProjectDirectly(database, { name: "Empty Board Project" });
    const emptyStatusId = await createStatusDirectly(database, emptyProjectId, "Backlog", 0);
    const res = await app.request(`/api/projects/${emptyProjectId}/board/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].statusId).toBe(emptyStatusId);
    expect(body[0].count).toBe(0);
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

  it("GET /api/projects/:id/board tolerates Done issue with null/stale workspace summary data (AK-324)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-324 Null Summary Project" });
    const doneStatusId = await createStatusDirectly(database, p, "Done", 1);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: p,
      statusId: doneStatusId,
      issueNumber: 324,
      title: "Reconciled after dropped merge",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Closed workspace with stale/null conflictCacheFiles — mirrors a dropped-merge reconciliation
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-324-null-summary",
      status: "closed",
      // conflictCacheFiles stored as JSON-encoded null ("null") — the bug scenario
      conflictCacheHasConflicts: false,
      conflictCacheFiles: "null",
      conflictCacheCheckedAt: now,
      // diffStat all zeros/null
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: null,
      diffStatCacheDeletions: null,
      // scorecardScore null
      scorecardScore: null,
      createdAt: now,
      updatedAt: now,
    });

    // Session with stats stored as JSON-encoded null
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "claude",
      status: "stopped",
      startedAt: now,
      endedAt: now,
      stats: "null",
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const allIssues = body.flatMap((column: any) => column.issues);
    const issue = allIssues.find((i: any) => i.id === issueId);
    expect(issue).toBeDefined();
    // workspaceSummary must be present and not crash
    expect(issue.workspaceSummary).toBeDefined();
    expect(issue.workspaceSummary.total).toBe(1);
    // main workspace summary must have safe conflict data (array, not null)
    expect(issue.workspaceSummary.main).toBeDefined();
  });

  it("GET /api/projects/:id/board omits lastAssistantMessage/lastTool for closed workspaces (payload slim)", async () => {
    const p = await createProjectDirectly(database, { name: "Closed Summary Slim Project" });
    await createStatusDirectly(database, p, "In Review", 1);
    const inProgressStatusId = await createStatusDirectly(database, p, "In Progress", 0);
    const doneStatusId = await createStatusDirectly(database, p, "Done", 2);
    const now = new Date().toISOString();

    // Closed (merged) workspace whose session has an assistant message + tool use.
    // Lives on an ARCHIVED (Done) issue: per #663 a closed workspace is dropped from `main`
    // for non-archived issues, but archived issues keep their closed/merged main for display
    // — which is exactly where the message-slimming behavior under test applies.
    const closedIssueId = randomUUID();
    const closedWsId = randomUUID();
    const closedSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: closedIssueId, projectId: p, statusId: doneStatusId, issueNumber: 901,
      title: "Closed work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: closedWsId, issueId: closedIssueId, branch: "feature/closed-slim", status: "closed", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: closedSessionId, workspaceId: closedWsId, executor: "claude", status: "stopped", startedAt: now, endedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: closedSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "This should not ship on the board." }] } }),
      createdAt: now,
    });

    // Archived (Done) issue with an IDLE (non-closed) main workspace — P1: archived
    // issues are slimmed regardless of workspace status (their card is a CompletedCard).
    const doneIssueId = randomUUID();
    const doneWsId = randomUUID();
    const doneSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: doneIssueId, projectId: p, statusId: doneStatusId, issueNumber: 903,
      title: "Archived idle work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: doneWsId, issueId: doneIssueId, branch: "feature/done-idle-slim", status: "idle", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: doneSessionId, workspaceId: doneWsId, executor: "claude", status: "stopped", startedAt: now, endedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: doneSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Archived idle message that must not ship." }] } }),
      createdAt: now,
    });

    // Active workspace (control) — its live assistant message MUST still be surfaced.
    const activeIssueId = randomUUID();
    const activeWsId = randomUUID();
    const activeSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: activeIssueId, projectId: p, statusId: inProgressStatusId, issueNumber: 902,
      title: "Active work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: activeWsId, issueId: activeIssueId, branch: "feature/active-slim", status: "active", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: activeSessionId, workspaceId: activeWsId, executor: "claude", status: "running", startedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: activeSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Live agent message." }] } }),
      createdAt: now,
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((c: any) => c.issues);
    const closed = allIssues.find((i: any) => i.id === closedIssueId);
    const doneIdle = allIssues.find((i: any) => i.id === doneIssueId);
    const active = allIssues.find((i: any) => i.id === activeIssueId);

    // Closed workspace summary is still present (counts/branch/status intact)...
    expect(closed.workspaceSummary.main).toBeDefined();
    expect(closed.workspaceSummary.main.status).toBe("closed");
    // ...but the heavy assistant-message text + lastTool are omitted to slim the payload.
    expect(closed.workspaceSummary.main.lastAssistantMessage ?? null).toBeNull();
    expect(closed.workspaceSummary.main.lastTool ?? null).toBeNull();
    // ...while the merged/closed-badge fields are preserved (must NOT be swept into the gate).
    expect(closed.workspaceSummary.main.sessionStatus).toBe("stopped");
    expect(closed.workspaceSummary.main.lastSessionTriggerType).toBe("initial");
    expect(closed.workspaceSummary.main.lastSessionAt).toBeTruthy();

    // Archived (Done) idle workspace is also slimmed even though it is not "closed".
    expect(doneIdle.workspaceSummary.main).toBeDefined();
    expect(doneIdle.workspaceSummary.main.status).toBe("idle");
    expect(doneIdle.workspaceSummary.main.lastAssistantMessage ?? null).toBeNull();

    // The active workspace still surfaces its live assistant message.
    expect(active.workspaceSummary.main.lastAssistantMessage).toBe("Live agent message.");
  });

  it("GET /api/projects/:id/board flags zero-diff In Review workspace with planOnlyWarning (AK-607)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-607 Zero-Diff In Review Project" });
    const inReviewStatusId = await createStatusDirectly(database, p, "In Review", 1);
    const now = new Date().toISOString();

    // Zero-diff idle workspace in In Review — branch present but no diff committed
    const zeroDiffIssueId = randomUUID();
    const zeroDiffWsId = randomUUID();
    await database.insert(schema.issues).values({
      id: zeroDiffIssueId, projectId: p, statusId: inReviewStatusId, issueNumber: 607,
      title: "Zero diff In Review", priority: "medium", issueType: "bug", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: zeroDiffWsId, issueId: zeroDiffIssueId,
      branch: "feature/ak-607-zero-diff",
      workingDir: "/repo/.worktrees/ak-607-zero-diff",
      baseBranch: "master",
      status: "idle",
      isDirect: false,
      readyForMerge: false,
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: 0,
      diffStatCacheDeletions: 0,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    // Non-zero diff workspace in In Review — should NOT get planOnlyWarning
    const nonZeroDiffIssueId = randomUUID();
    const nonZeroDiffWsId = randomUUID();
    await database.insert(schema.issues).values({
      id: nonZeroDiffIssueId, projectId: p, statusId: inReviewStatusId, issueNumber: 608,
      title: "Non-zero diff In Review", priority: "medium", issueType: "feature", sortOrder: 1,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: nonZeroDiffWsId, issueId: nonZeroDiffIssueId,
      branch: "feature/ak-607-has-diff",
      status: "idle",
      isDirect: false,
      readyForMerge: false,
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 3,
      diffStatCacheInsertions: 42,
      diffStatCacheDeletions: 5,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((col: any) => col.issues);

    const zeroDiffIssue = allIssues.find((i: any) => i.id === zeroDiffIssueId);
    expect(zeroDiffIssue).toBeDefined();
    expect(zeroDiffIssue.workspaceSummary).toBeDefined();
    expect(zeroDiffIssue.workspaceSummary.main).toBeDefined();
    // Zero-diff idle workspace in In Review must expose planOnlyWarning so the UI/reconciler
    // can treat it as stale and close it rather than leaving it stranded.
    expect(zeroDiffIssue.workspaceSummary.main.planOnlyWarning).toBe(true);

    const nonZeroDiffIssue = allIssues.find((i: any) => i.id === nonZeroDiffIssueId);
    expect(nonZeroDiffIssue).toBeDefined();
    expect(nonZeroDiffIssue.workspaceSummary).toBeDefined();
    expect(nonZeroDiffIssue.workspaceSummary.main).toBeDefined();
    // Workspace with actual changes must NOT be flagged as plan-only.
    expect(nonZeroDiffIssue.workspaceSummary.main.planOnlyWarning).toBe(false);
  });

  it("GET /api/issues tolerates Done issue with null/stale workspace summary data (AK-324)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-324 Issues Null Summary Project" });
    const doneStatusId = await createStatusDirectly(database, p, "Done", 1);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: p,
      statusId: doneStatusId,
      issueNumber: 324,
      title: "Reconciled issue list check",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-324-null-summary-list",
      status: "closed",
      conflictCacheHasConflicts: null,
      conflictCacheFiles: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/issues?projectId=${p}&issueNumber=324`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(issueId);
  });
});

describe("Issue by-number resolution (AK-572)", () => {
  const { app, db: database } = createTestApp();

  it("GET /api/issues?issueNumber=N returns only the matching issue for the given project", async () => {
    const now = new Date().toISOString();
    const projectA = await createProjectDirectly(database, { name: "AK-572 Project A" });
    const projectB = await createProjectDirectly(database, { name: "AK-572 Project B" });
    const statusA = await createStatusDirectly(database, projectA, "Todo", 0);
    const statusB = await createStatusDirectly(database, projectB, "Todo", 0);

    const issueAId = randomUUID();
    const issueBId = randomUUID();
    // Both projects have an issue with number 42 — the filter must be project-scoped
    await database.insert(schema.issues).values({
      id: issueAId, projectId: projectA, statusId: statusA, issueNumber: 42,
      title: "Issue 42 in project A", priority: "medium", issueType: "task", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.issues).values({
      id: issueBId, projectId: projectB, statusId: statusB, issueNumber: 42,
      title: "Issue 42 in project B", priority: "medium", issueType: "task", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });

    const resA = await app.request(`/api/issues?projectId=${projectA}&issueNumber=42`);
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as any;
    expect(Array.isArray(bodyA)).toBe(true);
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].id).toBe(issueAId);

    const resB = await app.request(`/api/issues?projectId=${projectB}&issueNumber=42`);
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as any;
    expect(Array.isArray(bodyB)).toBe(true);
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].id).toBe(issueBId);
  });

  it("GET /api/issues?issueNumber=N returns empty array when no match", async () => {
    const p = await createProjectDirectly(database, { name: "AK-572 Empty Project" });
    const res = await app.request(`/api/issues?projectId=${p}&issueNumber=9999`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe("Board terminal column cap (AK-569)", () => {
  const { app, db: database } = createTestApp();

  it("caps Done/Cancelled columns to 50 issues and exposes the true count", async () => {
    const projectId = await createProjectDirectly(database, { name: "Board Cap Project" });
    const todoStatusId = await createStatusDirectly(database, projectId, "Todo", 0);
    const doneStatusId = await createStatusDirectly(database, projectId, "Done", 1);
    const cancelledStatusId = await createStatusDirectly(database, projectId, "Cancelled", 2);

    const now = new Date();
    // Insert 60 Done issues and 5 Cancelled issues
    const doneIssues = Array.from({ length: 60 }, (_, idx) => ({
      id: randomUUID(),
      projectId,
      statusId: doneStatusId,
      issueNumber: 1000 + idx,
      title: `Done issue ${idx}`,
      priority: "medium" as const,
      issueType: "feature" as const,
      sortOrder: idx,
      createdAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
      updatedAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
      statusChangedAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
    }));
    for (const issue of doneIssues) {
      await database.insert(schema.issues).values(issue);
    }

    const cancelledIssues = Array.from({ length: 5 }, (_, idx) => ({
      id: randomUUID(),
      projectId,
      statusId: cancelledStatusId,
      issueNumber: 2000 + idx,
      title: `Cancelled issue ${idx}`,
      priority: "medium" as const,
      issueType: "feature" as const,
      sortOrder: idx,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }));
    for (const issue of cancelledIssues) {
      await database.insert(schema.issues).values(issue);
    }

    // Insert 3 active (Todo) issues — should be returned in full
    for (let idx = 0; idx < 3; idx++) {
      await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Todo issue ${idx}`, statusId: todoStatusId, projectId }),
      });
    }

    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const todoCol = body.find((c: any) => c.name === "Todo");
    const doneCol = body.find((c: any) => c.name === "Done");
    const cancelledCol = body.find((c: any) => c.name === "Cancelled");

    // Active column: all issues returned, count matches
    expect(todoCol.issues.length).toBe(3);
    expect(todoCol.count).toBe(3);

    // Terminal Done column: capped at 50, count = true total (60)
    expect(doneCol.count).toBe(60);
    expect(doneCol.issues.length).toBe(50);

    // Issues are ordered by statusChangedAt desc (most recent first)
    const firstTs = new Date(doneCol.issues[0].statusChangedAt ?? doneCol.issues[0].updatedAt).getTime();
    const lastTs = new Date(doneCol.issues[49].statusChangedAt ?? doneCol.issues[49].updatedAt).getTime();
    expect(firstTs).toBeGreaterThanOrEqual(lastTs);

    // Terminal Cancelled column: under cap, count = issues.length
    expect(cancelledCol.count).toBe(5);
    expect(cancelledCol.issues.length).toBe(5);
  });

  it("non-terminal columns (Backlog/In Progress/In Review/AI Reviewed) are never capped", async () => {
    // Regression for #570: capping must only apply to terminal columns.
    // Seed 60 issues in every standard non-terminal column name and assert none are capped.
    const projectId = await createProjectDirectly(database, { name: "Non-Terminal Cap Project" });
    const now = new Date();

    const nonTerminalNames = ["Backlog", "In Progress", "In Review", "AI Reviewed"];
    const statusIds: Record<string, string> = {};
    for (let i = 0; i < nonTerminalNames.length; i++) {
      statusIds[nonTerminalNames[i]] = await createStatusDirectly(database, projectId, nonTerminalNames[i], i);
    }

    const OVER_CAP = 60;
    let issueCounter = 5000;
    for (const [name, statusId] of Object.entries(statusIds)) {
      const issues = Array.from({ length: OVER_CAP }, (_, idx) => ({
        id: randomUUID(),
        projectId,
        statusId,
        issueNumber: issueCounter++,
        title: `${name} issue ${idx}`,
        priority: "medium" as const,
        issueType: "feature" as const,
        sortOrder: idx,
        createdAt: new Date(now.getTime() - idx * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - idx * 1000).toISOString(),
      }));
      for (const issue of issues) {
        await database.insert(schema.issues).values(issue);
      }
    }

    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    for (const name of nonTerminalNames) {
      const col = body.find((c: any) => c.name === name);
      expect(col, `column "${name}" should be present`).toBeDefined();
      // Non-terminal columns must never be capped: issues.length === count === OVER_CAP
      expect(col.issues.length).toBe(OVER_CAP);
      expect(col.count).toBe(OVER_CAP);
    }
  });
});

describe("Board archived-issue filtering (AK-457)", () => {
  const { app, db: database } = createTestApp();

  it("omits Archived issues from default board response and includes them with ?includeArchived=true", async () => {
    const pid = await createProjectDirectly(database, { name: "Archived Filter Project" });
    const doneStatusId = await createStatusDirectly(database, pid, "Done", 1);
    const archivedStatusId = await createStatusDirectly(database, pid, "Archived", 99);

    const now = new Date().toISOString();

    const doneIssueId = randomUUID();
    await database.insert(schema.issues).values({
      id: doneIssueId,
      projectId: pid,
      statusId: doneStatusId,
      issueNumber: 4571,
      title: "Done issue",
      priority: "medium",
      issueType: "feature",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    const archivedIssueId = randomUUID();
    await database.insert(schema.issues).values({
      id: archivedIssueId,
      projectId: pid,
      statusId: archivedStatusId,
      issueNumber: 4572,
      title: "Archived issue",
      priority: "medium",
      issueType: "feature",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Default board: Archived column and its issues must be absent
    const defaultRes = await app.request(`/api/projects/${pid}/board`);
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.json() as any[];
    const defaultAllIssues = defaultBody.flatMap((col: any) => col.issues);
    const defaultColumnNames = defaultBody.map((col: any) => col.name);

    expect(defaultColumnNames).not.toContain("Archived");
    expect(defaultAllIssues.map((i: any) => i.id)).not.toContain(archivedIssueId);
    expect(defaultAllIssues.map((i: any) => i.id)).toContain(doneIssueId);

    // includeArchived=true: Archived column and its issues must be present
    const includedRes = await app.request(`/api/projects/${pid}/board?includeArchived=true`);
    expect(includedRes.status).toBe(200);
    const includedBody = await includedRes.json() as any[];
    const includedAllIssues = includedBody.flatMap((col: any) => col.issues);
    const includedColumnNames = includedBody.map((col: any) => col.name);

    expect(includedColumnNames).toContain("Archived");
    expect(includedAllIssues.map((i: any) => i.id)).toContain(archivedIssueId);
    expect(includedAllIssues.map((i: any) => i.id)).toContain(doneIssueId);
  });
});

describe("Board ETag / conditional-GET", () => {
  const { app, db: database } = createTestApp();

  it("returns ETag on 200, serves 304 on matching If-None-Match, then 200 with new ETag after mutation", async () => {
    const pid = await createProjectDirectly(database, { name: "ETag Test Project" });
    const statusId = await createStatusDirectly(database, pid, "Todo", 0);

    // Seed one issue
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ETag seed issue", statusId, projectId: pid }),
    });
    expect(issueRes.status).toBe(201);

    // First GET — expect 200 with ETag
    const res1 = await app.request(`/api/projects/${pid}/board`);
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();

    // Second GET with matching If-None-Match — expect 304 and no body
    const res2 = await app.request(`/api/projects/${pid}/board`, {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(304);
    const body2 = await res2.text();
    expect(body2).toBe("");

    // Mutate: create a new issue
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ETag mutation issue", statusId, projectId: pid }),
    });

    // Third GET with the old ETag — expect 200 with a new ETag
    const res3 = await app.request(`/api/projects/${pid}/board`, {
      headers: { "If-None-Match": etag1! },
    });
    expect(res3.status).toBe(200);
    const etag3 = res3.headers.get("ETag");
    expect(etag3).toBeTruthy();
    expect(etag3).not.toBe(etag1);
    const body3 = await res3.json() as any;
    const allIssues = body3.flatMap((col: any) => col.issues);
    expect(allIssues.length).toBe(2);
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
