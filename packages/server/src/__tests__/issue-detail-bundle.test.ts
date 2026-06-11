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

async function seedProject(db: TestDb, name = "bundle-project") {
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

async function seedIssue(db: TestDb, projectId: string, description: string | null) {
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
    title: "Bundle issue",
    description,
    statusId,
    projectId,
    issueNumber: 1,
  });
  return issueId;
}

describe("GET /api/issues/:id/detail-bundle", () => {
  it("returns 404 for an unknown issue", async () => {
    const { app } = createTestApp();
    const res = await app.request(`/api/issues/${randomUUID()}/detail-bundle`);
    expect(res.status).toBe(404);
  });

  it("returns the issue (with description) plus all per-issue sections in one response", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const description = "A full description that the board payload strips";
    const issueId = await seedIssue(db, projectId, description);
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/bundle",
      status: "idle",
    });

    const res = await app.request(`/api/issues/${issueId}/detail-bundle`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // The bundle re-supplies the lazy-loaded description.
    expect(body.issue.id).toBe(issueId);
    expect(body.issue.description).toBe(description);

    // Every per-issue section the panel needs is present with a sane shape.
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces.map((w: any) => w.id)).toContain(workspaceId);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.dependencies).toBeTruthy();
    expect(Array.isArray(body.dependencies.dependencies)).toBe(true);
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(Array.isArray(body.comments)).toBe(true);
    expect(Array.isArray(body.activity.events)).toBe(true);
  });

  it("handles a null description without failing the bundle", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);
    const issueId = await seedIssue(db, projectId, null);

    const res = await app.request(`/api/issues/${issueId}/detail-bundle`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.issue.id).toBe(issueId);
    expect(body.issue.description).toBeNull();
    expect(body.workspaces).toEqual([]);
  });
});
