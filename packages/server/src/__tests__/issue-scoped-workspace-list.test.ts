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

// Unique per-issue number: migration 0094 enforces UNIQUE(project_id, issue_number),
// so seeding several issues into one project needs distinct numbers. Each test uses a
// fresh DB, so a monotonic counter is unique within any one DB.
let issueSeq = 0;

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
    issueNumber: ++issueSeq,
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

describe("GET /api/workspaces?issueId= (issue-scoped workspace list)", () => {
  it("returns 400 when neither projectId nor issueId is provided", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(400);
  });

  it("returns only workspaces belonging to the given issue", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueA = await seedIssue(db, projectId, "Issue A");
    const issueB = await seedIssue(db, projectId, "Issue B");
    const workspaceA1 = await seedWorkspace(db, issueA, "feature/a-1");
    const workspaceA2 = await seedWorkspace(db, issueA, "feature/a-2");
    await seedWorkspace(db, issueB, "feature/b");

    const res = await app.request(`/api/workspaces?issueId=${issueA}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBe(2);
    const ids = body.map((w: any) => w.id);
    expect(ids).toContain(workspaceA1);
    expect(ids).toContain(workspaceA2);
  });

  it("does not return workspaces from other issues", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueA = await seedIssue(db, projectId, "Issue A");
    const issueB = await seedIssue(db, projectId, "Issue B");
    await seedWorkspace(db, issueB, "feature/b");

    const res = await app.request(`/api/workspaces?issueId=${issueA}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([]);
  });

  it("returns an empty array for an unknown issueId", async () => {
    const { app } = createTestApp();
    const unknownId = randomUUID();

    const res = await app.request(`/api/workspaces?issueId=${unknownId}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([]);
  });

  it("returns workspaces with the expected shape fields", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueId = await seedIssue(db, projectId);
    const workspaceId = await seedWorkspace(db, issueId);

    const res = await app.request(`/api/workspaces?issueId=${issueId}`);

    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBe(1);
    const w = body[0];
    expect(w.id).toBe(workspaceId);
    expect(w.issueId).toBe(issueId);
    expect(w.branch).toBe("feature/test");
    expect(w.status).toBe("idle");
    expect(w).toHaveProperty("readyForMerge");
    expect(w).toHaveProperty("provider");
    expect(w).toHaveProperty("createdAt");
    expect(w).toHaveProperty("updatedAt");
  });
});
