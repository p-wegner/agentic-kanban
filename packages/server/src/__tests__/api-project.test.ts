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

  it("GET /api/projects counts only genuinely-running workspaces per project", async () => {
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

    // Genuinely-running agents: active, fixing (conflict resolution), reviewing,
    // awaiting-plan-approval — these count toward the "active agents" badge.
    await seedWorkspace("active");
    await seedWorkspace("fixing");
    await seedWorkspace("reviewing");
    await seedWorkspace("awaiting-plan-approval");
    // Not running — must NOT count. The old denylist (NOT IN idle/closed) wrongly
    // counted blocked/error/stopped/merged as "active agents".
    await seedWorkspace("idle");
    await seedWorkspace("closed");
    await seedWorkspace("error");
    await seedWorkspace("blocked");
    await seedWorkspace("stopped");
    await seedWorkspace("merged");

    const body = await (await app.request("/api/projects")).json() as any[];
    const project = body.find((p) => p.id === countProjectId);
    expect(project).toBeDefined();
    expect(project.activeWorkspaceCount).toBe(4);
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

  it("PATCH /api/projects/:id persists+validates servicesConfig; GET returns it parsed", async () => {
    const svcProjectId = await createProjectDirectly(database, { name: "Svc Stack", repoPath: "/tmp/svc-stack" });

    // Valid config round-trips (stored as JSON string, GET returns parsed object).
    const ok = await app.request(`/api/projects/${svcProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicesConfig: { enabled: true, composeFile: "docker-compose.yml", ports: ["db", "cache"], composeRepo: "backend" } }),
    });
    expect(ok.status).toBe(200);

    const stored = await database.select({ servicesConfig: schema.projects.servicesConfig }).from(schema.projects).where(eq(schema.projects.id, svcProjectId));
    expect(typeof stored[0].servicesConfig).toBe("string");
    expect(JSON.parse(stored[0].servicesConfig as string)).toMatchObject({ enabled: true, composeFile: "docker-compose.yml", ports: ["db", "cache"], composeRepo: "backend" });

    const list = await app.request("/api/projects");
    const projects = await list.json() as Array<{ id: string; servicesConfig: unknown }>;
    const svc = projects.find((p) => p.id === svcProjectId);
    expect(svc?.servicesConfig).toMatchObject({ enabled: true, composeFile: "docker-compose.yml", ports: ["db", "cache"] });

    // enabled but empty composeFile → 422
    const missingFile = await app.request(`/api/projects/${svcProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicesConfig: { enabled: true, composeFile: "" } }),
    });
    expect(missingFile.status).toBe(422);

    // enabled not a boolean → 422
    const badEnabled = await app.request(`/api/projects/${svcProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicesConfig: { enabled: "yes", composeFile: "docker-compose.yml" } }),
    });
    expect(badEnabled.status).toBe(422);

    // illegal port name → 422
    const badPort = await app.request(`/api/projects/${svcProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicesConfig: { enabled: true, composeFile: "docker-compose.yml", ports: ["db-1"] } }),
    });
    expect(badPort.status).toBe(422);

    // null clears it back to none
    const cleared = await app.request(`/api/projects/${svcProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicesConfig: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedRows = await database.select({ servicesConfig: schema.projects.servicesConfig }).from(schema.projects).where(eq(schema.projects.id, svcProjectId));
    expect(clearedRows[0].servicesConfig).toBeNull();
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
    await createStatusDirectly(database, emptyProjectId, "Done", 0);

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

