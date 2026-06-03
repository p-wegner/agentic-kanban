/**
 * Focused unit tests for dependency graph edge operations:
 * add, remove, duplicate prevention, and cycle prevention.
 *
 * These exercise the HTTP layer (issue routes + issue service) via the in-process
 * Hono test app — no running dev server required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { domainErrorHandler } from "../middleware/error-handler.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.onError(domainErrorHandler);
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProjectWithIssues(db: TestDb, issueCount = 3) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Edge Test Project",
    repoPath: "/tmp/edge-test",
    repoName: "edge-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  const issueIds: string[] = [];
  for (let i = 0; i < issueCount; i++) {
    const id = randomUUID();
    await db.insert(schema.issues).values({
      id,
      issueNumber: i + 1,
      title: `Issue ${i + 1}`,
      priority: "medium",
      sortOrder: i,
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    issueIds.push(id);
  }

  return { projectId, issueIds };
}

describe("Dependency graph edge: add", () => {
  const { app, db } = createTestApp();
  let issueIds: string[];

  beforeEach(async () => {
    ({ issueIds } = await seedProjectWithIssues(db));
  });

  it("adds a depends_on edge and returns 201 with id and type", async () => {
    const [a, b] = issueIds;
    const res = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; type: string };
    expect(body.id).toBeDefined();
    expect(body.type).toBe("depends_on");
  });

  it("defaults to depends_on when type is omitted", async () => {
    const [a, b] = issueIds;
    const res = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { type: string };
    expect(body.type).toBe("depends_on");
  });

  it("adds a blocked_by edge", async () => {
    const [a, b] = issueIds;
    const res = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b, type: "blocked_by" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { type: string };
    expect(body.type).toBe("blocked_by");
  });

  it("adds a related_to edge (non-directional, no cycle check)", async () => {
    const [a, b] = issueIds;
    const res = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b, type: "related_to" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects adding a dependency to self (400)", async () => {
    const [a] = issueIds;
    const res = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: a, type: "depends_on" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/itself/i);
  });
});

describe("Dependency graph edge: remove", () => {
  const { app, db } = createTestApp();
  let issueIds: string[];

  beforeEach(async () => {
    ({ issueIds } = await seedProjectWithIssues(db));
  });

  it("removes an existing edge and returns success", async () => {
    const [a, b] = issueIds;
    // Add edge first
    const addRes = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    expect(addRes.status).toBe(201);
    const { id: depId } = await addRes.json() as { id: string };

    // Remove it
    const delRes = await app.request(`/api/issues/${a}/dependencies/${depId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { success: boolean };
    expect(delBody.success).toBe(true);
  });

  it("after removal the edge is gone from GET /dependencies", async () => {
    const [a, b] = issueIds;
    const addRes = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    const { id: depId } = await addRes.json() as { id: string };

    await app.request(`/api/issues/${a}/dependencies/${depId}`, { method: "DELETE" });

    const getRes = await app.request(`/api/issues/${a}/dependencies`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { dependencies: { id: string }[] };
    expect(body.dependencies.find((d) => d.id === depId)).toBeUndefined();
  });
});

describe("Dependency graph edge: duplicate prevention", () => {
  const { app, db } = createTestApp();
  let issueIds: string[];

  beforeEach(async () => {
    ({ issueIds } = await seedProjectWithIssues(db));
  });

  it("rejects adding the same dependency twice (409)", async () => {
    const [a, b] = issueIds;
    const payload = JSON.stringify({ dependsOnId: b, type: "depends_on" });
    const headers = { "Content-Type": "application/json" };

    const first = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers, body: payload,
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers, body: payload,
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/already exists/i);
  });

  it("allows the same pair with a different type (not a duplicate)", async () => {
    const [a, b] = issueIds;
    const headers = { "Content-Type": "application/json" };

    const first = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    expect(first.status).toBe(201);

    // related_to is a different type → not a duplicate
    const second = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "related_to" }),
    });
    expect(second.status).toBe(201);
  });
});

describe("Dependency graph edge: cycle prevention", () => {
  const { app, db } = createTestApp();
  let issueIds: string[];

  beforeEach(async () => {
    ({ issueIds } = await seedProjectWithIssues(db, 4));
  });

  it("rejects a direct A→B + B→A cycle (409)", async () => {
    const [a, b] = issueIds;
    const headers = { "Content-Type": "application/json" };

    const first = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/api/issues/${b}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: a, type: "depends_on" }),
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/cycle/i);
  });

  it("rejects a transitive cycle A→B→C + C→A (409)", async () => {
    const [a, b, c] = issueIds;
    const headers = { "Content-Type": "application/json" };

    await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    await app.request(`/api/issues/${b}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: c, type: "depends_on" }),
    });

    const closing = await app.request(`/api/issues/${c}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: a, type: "depends_on" }),
    });
    expect(closing.status).toBe(409);
    const body = await closing.json() as { error: string };
    expect(body.error).toMatch(/cycle/i);
  });

  it("does NOT block related_to reverse edges (non-directional, no cycle check)", async () => {
    const [a, b] = issueIds;
    const headers = { "Content-Type": "application/json" };

    await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "related_to" }),
    });

    // Reverse related_to is NOT a cycle — should succeed
    const reverse = await app.request(`/api/issues/${b}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: a, type: "related_to" }),
    });
    expect(reverse.status).toBe(201);
  });

  it("rejects blocked_by cycle (directional type)", async () => {
    const [a, b] = issueIds;
    const headers = { "Content-Type": "application/json" };

    await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "blocked_by" }),
    });

    const cycle = await app.request(`/api/issues/${b}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: a, type: "blocked_by" }),
    });
    expect(cycle.status).toBe(409);
  });

  it("allows a chain that does not close a cycle (A→B, A→C, B→D are all fine)", async () => {
    const [a, b, c, d] = issueIds;
    const headers = { "Content-Type": "application/json" };

    const r1 = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: b, type: "depends_on" }),
    });
    const r2 = await app.request(`/api/issues/${a}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: c, type: "depends_on" }),
    });
    const r3 = await app.request(`/api/issues/${b}/dependencies`, {
      method: "POST", headers,
      body: JSON.stringify({ dependsOnId: d, type: "depends_on" }),
    });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(201);
  });
});
