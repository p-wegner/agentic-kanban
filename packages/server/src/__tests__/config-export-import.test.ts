import { describe, it, expect, beforeEach } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function createProjectDirectly(database: TestDb) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name: "Export Test Project",
    repoPath: "/tmp/export-test-repo",
    repoName: "export-test-repo",
    defaultBranch: "main",
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

describe("Config Export/Import API", () => {
  const { app, db } = createTestApp();
  let projectId: string;

  beforeEach(async () => {
    projectId = await createProjectDirectly(db);
    await createStatusDirectly(db, projectId, "Backlog", 0);
    await createStatusDirectly(db, projectId, "In Progress", 1);
    await createStatusDirectly(db, projectId, "Done", 2);

    // Set some preferences
    await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_merge: "true",
        auto_review: "false",
        [`board_strategy_${projectId}`]: JSON.stringify({ version: 1, activeAgentsTarget: 3 }),
      }),
    });
  });

  it("GET export returns JSON with statuses and prefs", async () => {
    const res = await app.request(`/api/projects/${projectId}/config/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe(1);
    expect(body.projectId).toBe(projectId);
    expect(Array.isArray(body.statuses)).toBe(true);
    const statuses = body.statuses as Array<{ name: string; sortOrder: number }>;
    expect(statuses.map((s) => s.name)).toEqual(expect.arrayContaining(["Backlog", "In Progress", "Done"]));
    expect((body.workflowPreferences as Record<string, string>).auto_merge).toBe("true");
    expect((body.workflowPreferences as Record<string, string>).auto_review).toBe("false");
    expect(body.boardStrategy).toMatchObject({ version: 1, activeAgentsTarget: 3 });
  });

  it("export does not include secret or profile keys", async () => {
    await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_profile: "anth", provider: "claude" }),
    });

    const res = await app.request(`/api/projects/${projectId}/config/export`);
    const body = await res.json() as Record<string, unknown>;
    const prefs = body.workflowPreferences as Record<string, string>;
    expect(prefs.claude_profile).toBeUndefined();
    expect(prefs.provider).toBeUndefined();
  });

  it("dryRun=true returns preview without applying changes", async () => {
    const targetProjectId = await createProjectDirectly(db);

    // export from source project
    const exportRes = await app.request(`/api/projects/${projectId}/config/export`);
    const exportBody = await exportRes.json();

    const res = await app.request(`/api/projects/${targetProjectId}/config/import?dryRun=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body.statusChanges).toBeDefined();

    // Target project has no statuses yet, so all source statuses should appear as toAdd
    const changes = body.statusChanges as { toAdd: unknown[]; toUpdate: unknown[] };
    expect(changes.toAdd.length).toBe(3);
  });

  it("round-trip: export then import on a fresh project reproduces statuses and strategy", async () => {
    // Export from source project
    const exportRes = await app.request(`/api/projects/${projectId}/config/export`);
    const exportBody = await exportRes.json();

    // Import into a new project
    const targetProjectId = await createProjectDirectly(db);
    const importRes = await app.request(`/api/projects/${targetProjectId}/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportBody),
    });
    expect(importRes.status).toBe(200);

    // Check statuses were created
    const statusesRes = await app.request(`/api/projects/${targetProjectId}/statuses`);
    expect(statusesRes.status).toBe(200);
    const statusesBody = await statusesRes.json() as Array<{ name: string; sortOrder: number }>;
    expect(statusesBody.map((s) => s.name)).toEqual(expect.arrayContaining(["Backlog", "In Progress", "Done"]));

    // Check preferences were applied
    const prefsRes = await app.request("/api/preferences/settings");
    const prefsBody = await prefsRes.json() as Record<string, string>;
    expect(prefsBody.auto_merge).toBe("true");
    expect(prefsBody[`board_strategy_${targetProjectId}`]).toBeDefined();
    const strategy = JSON.parse(prefsBody[`board_strategy_${targetProjectId}`]);
    expect(strategy.activeAgentsTarget).toBe(3);
  });

  it("import rejects invalid shape", async () => {
    const res = await app.request(`/api/projects/${projectId}/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 99, statuses: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("import ignores disallowed preference keys", async () => {
    const targetProjectId = await createProjectDirectly(db);

    const maliciousPayload = {
      version: 1,
      projectId,
      statuses: [],
      boardStrategy: null,
      workflowPreferences: {
        auto_merge: "true",
        claude_profile: "evil",
        provider: "evil",
      },
    };

    await app.request(`/api/projects/${targetProjectId}/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(maliciousPayload),
    });

    const prefsRes = await app.request("/api/preferences/settings");
    const prefsBody = await prefsRes.json() as Record<string, string>;
    // Should not have applied evil values to sensitive keys
    expect(prefsBody.claude_profile).not.toBe("evil");
    expect(prefsBody.provider).not.toBe("evil");
  });
});
