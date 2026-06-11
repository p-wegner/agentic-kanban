/**
 * Tests for the opt-in ?slim=1 param on GET /api/issues.
 * slim=1 omits the description field (the bulk of the payload) from every
 * issue in the list; the default response shape is unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssuesRoute } from "../routes/issues.js";

async function seedProject(db: TestDb) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id, name: `project-${id.slice(0, 8)}`, repoPath: `/tmp/${id}`,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedStatus(db: TestDb, projectId: string, name: string, sortOrder: number) {
  const id = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id, projectId, name, sortOrder, isDefault: sortOrder === 0, createdAt: new Date().toISOString(),
  });
  return id;
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number, description: string | null) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber, title: `Issue ${issueNumber}`, description,
    statusId, projectId, createdAt: now, updatedAt: now, sortOrder: issueNumber,
  });
  return id;
}

describe("GET /api/issues ?slim=1", () => {
  let app: Hono;
  let db: TestDb;
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    app = new Hono();
    app.route("/api/issues", createIssuesRoute(db));
    projectId = await seedProject(db);
    statusId = await seedStatus(db, projectId, "Backlog", 0);
    await seedIssue(db, projectId, statusId, 1, "A long description that should be omitted in slim mode");
    await seedIssue(db, projectId, statusId, 2, null);
  });

  it("default response still includes description (shape unchanged)", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(2);
    const withDesc = list.find(i => i.issueNumber === 1)!;
    expect(withDesc.description).toBe("A long description that should be omitted in slim mode");
    const nullDesc = list.find(i => i.issueNumber === 2)!;
    // Null description stays an explicit null key in the default response
    expect("description" in nullDesc).toBe(true);
    expect(nullDesc.description).toBeNull();
  });

  it("slim=1 omits the description key entirely (absent, not null)", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&slim=1`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(2);
    for (const issue of list) {
      expect("description" in issue).toBe(false);
    }
    // Everything else the picker/list consumers need is still present
    const first = list.find(i => i.issueNumber === 1)!;
    expect(first.id).toBeDefined();
    expect(first.title).toBe("Issue 1");
    expect(first.statusName).toBe("Backlog");
    expect(first.statusId).toBe(statusId);
    expect(first.projectId).toBe(projectId);
  });

  it("slim=1 composes with issueNumber and statusName filters", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&issueNumber=1&statusName=Backlog&slim=1`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0].issueNumber).toBe(1);
    expect("description" in list[0]).toBe(false);
  });

  it("slim with any other value than 1 keeps the full response", async () => {
    const res = await app.request(`/api/issues?projectId=${projectId}&slim=true`);
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    const withDesc = list.find(i => i.issueNumber === 1)!;
    expect(withDesc.description).toBe("A long description that should be omitted in slim mode");
  });
});
