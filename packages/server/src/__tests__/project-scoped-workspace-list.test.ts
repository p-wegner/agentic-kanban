import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as createHarness } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return createHarness((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProject(db: TestDb, name = "test-project") {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name}`,
    repoName: name,
    defaultBranch: "main",
  });
  return projectId;
}

async function seedIssue(db: TestDb, projectId: string, title = "Test issue") {
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
  }).onConflictDoNothing();

  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    title,
    statusId,
    projectId,
    issueNumber: 1,
  });
  return issueId;
}

async function seedWorkspace(db: TestDb, issueId: string, branch = "feature/test") {
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    status: "idle",
  });
  return workspaceId;
}

describe("GET /api/workspaces?projectId= (project-scoped workspace list)", () => {
  it("returns 200 with workspaces belonging to the given project", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueId = await seedIssue(db, projectId);
    const workspaceId = await seedWorkspace(db, issueId);

    const res = await app.request(`/api/workspaces?projectId=${projectId}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(workspaceId);
  });

  it("returns only workspaces scoped to the given project, not other projects", async () => {
    const { app, db } = createTestApp();

    const projectA = await seedProject(db, "project-a");
    const issueA = await seedIssue(db, projectA, "Issue A");
    const workspaceA = await seedWorkspace(db, issueA, "feature/a");

    const projectB = await seedProject(db, "project-b");
    const issueB = await seedIssue(db, projectB, "Issue B");
    await seedWorkspace(db, issueB, "feature/b");

    const res = await app.request(`/api/workspaces?projectId=${projectA}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(workspaceA);
  });

  it("returns an empty array for an unknown projectId (not 404 or 500)", async () => {
    const { app } = createTestApp();
    const unknownId = randomUUID();

    const res = await app.request(`/api/workspaces?projectId=${unknownId}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([]);
  });
});
