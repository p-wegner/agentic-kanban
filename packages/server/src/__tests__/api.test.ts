import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createRoutes } from "../routes/index.js";
import type { SessionManager } from "../services/session.manager.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "../../../shared/drizzle/0000_flawless_trauma.sql",
  "../../../shared/drizzle/0001_magical_johnny_storm.sql",
  "../../../shared/drizzle/0002_bent_may_parker.sql",
  "../../../shared/drizzle/0003_tough_lightspeed.sql",
  "../../../shared/drizzle/0004_boring_wind_dancer.sql",
  "../../../shared/drizzle/0005_silky_frog_thor.sql",
  "../../../shared/drizzle/0006_wide_ogun.sql",
  "../../../shared/drizzle/0007_diff_comments.sql",
];

function createTestApp() {
  const client = createClient({ url: ":memory:" });
  // Execute all migration statements
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(__dirname, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }

  const database = drizzle(client, { schema });
  const app = new Hono();

  // Mock session manager for tests
  const mockSessionManager = {
    startSession: async () => "mock-session-id",
    stopSession: async () => true,
    subscribe: () => {},
    unsubscribe: () => {},
    wsRoute: () => () => {},
  } as unknown as SessionManager;

  app.route("/api", createRoutes(database, () => mockSessionManager));
  return { app, db: database };
}

// Helper: create a project directly in DB (bypassing git-info detection)
async function createProjectDirectly(database: ReturnType<typeof drizzle<typeof schema>>, overrides: { name?: string } = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name: overrides.name || "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createStatusDirectly(database: ReturnType<typeof drizzle<typeof schema>>, projectId: string, name: string, sortOrder: number) {
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
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].name).toBeDefined();
    expect(body[0].repoPath).toBeDefined();
  });

  it("GET /api/projects/:id/branches returns error for non-git path", async () => {
    const res = await app.request(`/api/projects/${projectId}/branches`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to list branches");
  });

  it("GET /api/projects/:id/branches returns 404 for missing project", async () => {
    const res = await app.request(`/api/projects/${randomUUID()}/branches`);
    expect(res.status).toBe(404);
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
    const body = await res.json();
    expect(body.title).toBe("Test issue");
  });

  it("GET /api/issues returns issues with statusName", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
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

    const body = await res.json();
    expect(body.success).toBe(true);
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
    const body = await res.json();

    expect(body.length).toBe(2);
    expect(body[0].name).toBe("Todo");
    expect(body[0].issues.length).toBe(1);
    expect(body[0].issues[0].title).toBe("Task 1");
    expect(body[0].issues[0].statusName).toBe("Todo");
    expect(body[1].name).toBe("Done");
    expect(body[1].issues.length).toBe(1);
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify gone
    const getRes = await app.request(`/api/workspaces/${id}`);
    expect(getRes.status).toBe(404);
  });
});

describe("Preferences API", () => {
  const { app } = createTestApp();

  it("GET /api/preferences/active-project returns null initially", async () => {
    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.projectId).toBe(id2);
  });
});
