import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createRoutes } from "../routes/index.js";
import type { SessionManager } from "../services/session.manager.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
  "../../../shared/drizzle/0008_direct_workspace.sql",
  "../../../shared/drizzle/0009_requires_review.sql",
  "../../../shared/drizzle/0010_session_messages_cascade.sql",
  "../../../shared/drizzle/0011_timestamps.sql",
  "../../../shared/drizzle/0012_session_stats.sql",
  "../../../shared/drizzle/0013_plan_mode.sql",
  "../../../shared/drizzle/0014_issue_dependencies.sql",
  "../../../shared/drizzle/0015_ai_reviewed_status.sql",
  "../../../shared/drizzle/0016_skip_auto_review.sql",
  "../../../shared/drizzle/0017_agent_config.sql",
  "../../../shared/drizzle/0018_agent_skills.sql",
  "../../../shared/drizzle/0019_workspace_skill.sql",
  "../../../shared/drizzle/0023_dependency_types.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
  "../../../shared/drizzle/0025_provider_session_id.sql",
  "../../../shared/drizzle/0026_ready_for_merge.sql",
  "../../../shared/drizzle/0027_estimate_field.sql",
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
  "../../../shared/drizzle/0029_issue_artifacts.sql",
  "../../../shared/drizzle/0030_thorough_review.sql",
  "../../../shared/drizzle/0031_scheduled_runs.sql",
  "../../../shared/drizzle/0032_diff_stat_cache.sql",
  "../../../shared/drizzle/0033_backlog_status.sql",
  "../../../shared/drizzle/0034_session_pid.sql",
  "../../../shared/drizzle/0035_session_trigger.sql",
  "../../../shared/drizzle/0036_scheduled_runs_cron.sql",
  "../../../shared/drizzle/0037_workspace_provider.sql",
  "../../../shared/drizzle/0038_pending_plan_path.sql",
  "../../../shared/drizzle/0039_direct_workspace_base_commit.sql",
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
async function createProjectDirectly(database: ReturnType<typeof drizzle<typeof schema>>, overrides: {
  name?: string;
  repoPath?: string;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
} = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name: overrides.name || "Test Project",
    repoPath: overrides.repoPath || "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    setupScript: overrides.setupScript,
    setupBlocking: overrides.setupBlocking,
    setupEnabled: overrides.setupEnabled,
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
    const body = await res.json() as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].name).toBeDefined();
    expect(body[0].repoPath).toBeDefined();
  });

  it("GET /api/projects/:id/branches returns error for non-git path", async () => {
    const res = await app.request(`/api/projects/${projectId}/branches`);
    expect(res.status).toBe(500);
    const body = await res.json() as any;
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
    expect(existsSync(join(repoPath, "setup-ran.txt"))).toBe(false);
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
