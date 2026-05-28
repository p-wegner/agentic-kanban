import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import * as schema from "@agentic-kanban/shared/schema";
import { createIssuesRoute } from "../routes/issues.js";
import { applyMigrationsToClient } from "./helpers/test-db.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const tempDirs: string[] = [];

function createTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "ak-batch-test-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  applyMigrationsToClient(client);
  const db = drizzle(client, { schema }) as TestDb;
  const app = new Hono();
  app.route("/api/issues", createIssuesRoute(db));
  return { app, db };
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

async function seed(database: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

async function insertIssue(database: TestDb, projectId: string, statusId: string, num: number) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await database.insert(schema.issues).values({
    id, issueNumber: num, title: `I${num}`, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("POST /api/issues/batch", () => {
  const { app, db } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await seed(db));
  });

  it("creates 5 issues with consecutive numbers", async () => {
    const res = await app.request("/api/issues/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        issues: [
          { title: "T1" }, { title: "T2" }, { title: "T3" },
          { title: "T4" }, { title: "T5" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issues).toHaveLength(5);
    expect(body.issues.map((i: any) => i.issueNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns 400 with index on validation failure and persists nothing", async () => {
    const { app, db } = createTestApp();
    const { projectId } = await seed(db);

    const res = await app.request("/api/issues/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        issues: [{ title: "ok" }, { title: "  " }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.index).toBe(1);

    const rows = await db.select().from(schema.issues);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/issues/dependencies/batch", () => {
  it("adds and removes edges, idempotent for skips", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const a = await insertIssue(db, projectId, statusId, 1);
    const b = await insertIssue(db, projectId, statusId, 2);
    const c = await insertIssue(db, projectId, statusId, 3);

    const res = await app.request("/api/issues/dependencies/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edges: [
          { issueId: a, dependsOnId: b, action: "add" },
          { issueId: a, dependsOnId: c, action: "add" },
          { issueId: a, dependsOnId: b, action: "add" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.added).toBe(2);
    expect(body.skipped).toHaveLength(1);

    const rows = await db.select().from(schema.issueDependencies);
    expect(rows).toHaveLength(2);
  });

  it("rejects cycle and rolls back", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const a = await insertIssue(db, projectId, statusId, 1);
    const b = await insertIssue(db, projectId, statusId, 2);

    const res = await app.request("/api/issues/dependencies/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edges: [
          { issueId: a, dependsOnId: b, action: "add" },
          { issueId: b, dependsOnId: a, action: "add" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("cycle");

    const rows = await db.select().from(schema.issueDependencies);
    expect(rows).toHaveLength(0);
  });
});
