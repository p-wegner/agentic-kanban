import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();

async function createProject(db: TestDb, overrides: {
  defaultBranch?: string | null;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
} = {}) {
  const id = randomUUID();
  await db.insert(schema.projects).values({
    id,
    name: "Preview Test Project",
    repoPath: "/tmp/preview-test-repo",
    repoName: "preview-test-repo",
    defaultBranch: overrides.defaultBranch === undefined ? "main" : overrides.defaultBranch,
    setupScript: overrides.setupScript,
    setupBlocking: overrides.setupBlocking,
    setupEnabled: overrides.setupEnabled,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createStatus(db: TestDb, projectId: string, name: string, sortOrder: number) {
  const id = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    isDefault: sortOrder === 0,
    createdAt: now,
  });
  return id;
}

async function createIssue(db: TestDb, projectId: string, statusId: string, overrides: {
  issueNumber?: number;
  title?: string;
  priority?: string;
} = {}) {
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id,
    projectId,
    statusId,
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Test issue",
    description: "Test description",
    priority: overrides.priority ?? "medium",
    issueType: "task",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createWorkspace(db: TestDb, issueId: string, overrides: {
  branch?: string;
  status?: string;
  isDirect?: boolean;
} = {}) {
  const id = randomUUID();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: overrides.branch ?? "feature/test",
    workingDir: null,
    baseBranch: "main",
    isDirect: overrides.isDirect ?? false,
    requiresReview: false,
    thoroughReview: false,
    planMode: false,
    tddMode: false,
    includeVisualProof: false,
    readyForMerge: false,
    status: overrides.status ?? "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("POST /api/workspaces/preview", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;
  let issueId: string;

  beforeAll(async () => {
    projectId = await createProject(database);
    statusId = await createStatus(database, projectId, "Todo", 0);
    issueId = await createIssue(database, projectId, statusId, { issueNumber: 99, title: "Launch preview test" });
  });

  it("returns preview for a valid issue", async () => {
    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/ak-99-launch-preview", isDirect: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.branch).toBe("feature/ak-99-launch-preview");
    expect(body.baseBranch).toBe("main");
    expect(body.isDirect).toBe(false);
    expect(body.provider).toBe("claude");
    expect(body.warnings).toBeDefined();
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature/test" }),
    });
    expect(res.status).toBe(400);
  });

  it("resolves plan mode default for high-priority issues", async () => {
    const highIssueId = await createIssue(database, projectId, statusId, {
      issueNumber: 100,
      title: "Critical fix",
      priority: "high",
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: highIssueId, branch: "feature/ak-100-critical" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // High priority → plan mode defaults on when not explicitly set
    expect(body.planMode).toBe(true);
  });

  it("respects explicit planMode=false even for high priority", async () => {
    const highIssueId = await createIssue(database, projectId, statusId, {
      issueNumber: 101,
      title: "Critical no plan",
      priority: "critical",
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: highIssueId, branch: "feature/ak-101-critical", planMode: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.planMode).toBe(false);
  });

  it("warns about existing active workspaces on the same issue", async () => {
    // Create an active workspace on the issue
    await createWorkspace(database, issueId, { branch: "feature/ak-99-existing", status: "active" });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/ak-99-new" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings.some((w: string) => w.includes("active workspace"))).toBe(true);
  });

  it("warns about branch name collision", async () => {
    const branchName = "feature/ak-99-launch-preview";
    await createWorkspace(database, issueId, { branch: branchName, status: "closed" });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: branchName }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.warnings.some((w: string) => w.includes("already has a workspace"))).toBe(true);
  });

  it("warns when no base branch is configured and none provided", async () => {
    const noBranchProjectId = await createProject(database, { defaultBranch: null });
    const noBranchStatusId = await createStatus(database, noBranchProjectId, "Todo", 0);
    const noBranchIssueId = await createIssue(database, noBranchProjectId, noBranchStatusId, {
      issueNumber: 200,
      title: "No base branch",
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: noBranchIssueId, branch: "feature/test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.warnings.some((w: string) => w.includes("No base branch"))).toBe(true);
  });

  it("shows setup script info when project has one", async () => {
    const setupProjectId = await createProject(database, {
      setupScript: "pnpm install && pnpm build",
      setupBlocking: true,
      setupEnabled: true,
    });
    const setupStatusId = await createStatus(database, setupProjectId, "Todo", 0);
    const setupIssueId = await createIssue(database, setupProjectId, setupStatusId, {
      issueNumber: 300,
      title: "Setup script test",
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: setupIssueId, branch: "feature/test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.setupScript).not.toBeNull();
    expect(body.setupScript.command).toBe("pnpm install && pnpm build");
    expect(body.setupScript.blocking).toBe(true);
    expect(body.setupScript.willRun).toBe(true);
  });

  it("shows setup script as skipped when skipSetup is true", async () => {
    const setupProjectId = await createProject(database, {
      setupScript: "pnpm install",
      setupBlocking: true,
      setupEnabled: true,
    });
    const setupStatusId = await createStatus(database, setupProjectId, "Todo", 0);
    const setupIssueId = await createIssue(database, setupProjectId, setupStatusId, {
      issueNumber: 301,
      title: "Skip setup test",
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: setupIssueId, branch: "feature/test", skipSetup: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.setupScript.willRun).toBe(false);
  });

  it("resolves skill name from skillId", async () => {
    // Insert a skill
    const skillId = randomUUID();
    await database.insert(schema.agentSkills).values({
      id: skillId,
      name: "test-skill",
      description: "A test skill",
      prompt: "Do the thing",
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/test", skillId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.skill).not.toBeNull();
    expect(body.skill.name).toBe("test-skill");
  });

  it("resolves provider from profile override", async () => {
    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId,
        branch: "feature/test",
        profile: { provider: "codex", name: "default" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("codex");
  });

  it("is read-only — does not create a workspace", async () => {
    const freshProjectId = await createProject(database);
    const freshStatusId = await createStatus(database, freshProjectId, "Todo", 0);
    const freshIssueId = await createIssue(database, freshProjectId, freshStatusId, {
      issueNumber: 400,
      title: "No side effects",
    });

    // Count workspaces before
    const before = await database.select().from(schema.workspaces)
      .where(eq(schema.workspaces.issueId, freshIssueId));

    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: freshIssueId, branch: "feature/test" }),
    });
    expect(res.status).toBe(200);

    // Count workspaces after — must be the same
    const after = await database.select().from(schema.workspaces)
      .where(eq(schema.workspaces.issueId, freshIssueId));
    expect(after.length).toBe(before.length);
  });
});
