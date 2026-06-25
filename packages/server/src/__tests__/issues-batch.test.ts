import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and, inArray } from "drizzle-orm";
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
    id: projectId, name: "P", repoPath: `/tmp/p-${projectId}`, repoName: `p-${projectId}`,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  const cancelledStatusId = randomUUID();
  await database.insert(schema.projectStatuses).values([
    { id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
    { id: cancelledStatusId, projectId, name: "Cancelled", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  return { projectId, statusId, cancelledStatusId };
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

async function insertDependency(
  database: TestDb,
  issueId: string,
  dependsOnId: string,
  type: "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of" | "coupled_with" = "depends_on",
) {
  const id = randomUUID();
  await database.insert(schema.issueDependencies).values({
    id,
    issueId,
    dependsOnId,
    type,
    createdAt: new Date().toISOString(),
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

describe("POST /api/issues/batch — parentIssueId + driveTarget", () => {
  it("wires child_of edges when parentIssueId is provided", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const parentId = await insertIssue(db, projectId, statusId, 1);

    const res = await app.request("/api/issues/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        parentIssueId: parentId,
        issues: [{ title: "Child A" }, { title: "Child B" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.issues).toHaveLength(2);

    const deps = await db
      .select()
      .from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.dependsOnId, parentId), eq(schema.issueDependencies.type, "child_of")));
    expect(deps).toHaveLength(2);
    const childIds = body.issues.map((i: any) => i.id);
    expect(deps.map((d) => d.issueId).sort()).toEqual(childIds.sort());
  });

  it("auto-creates a Drive record when driveTarget is provided with parentIssueId", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const parentId = await insertIssue(db, projectId, statusId, 1);

    const res = await app.request("/api/issues/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        parentIssueId: parentId,
        driveTarget: "Deliver the feature",
        issues: [{ title: "Task 1" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.driveId).toBeTruthy();

    const drives = await db.select().from(schema.drives).where(eq(schema.drives.id, body.driveId));
    expect(drives).toHaveLength(1);
    expect(drives[0].metaIssueId).toBe(parentId);
    expect(drives[0].target).toBe("Deliver the feature");
    expect(drives[0].status).toBe("active");
  });

  it("does NOT create a Drive when driveTarget is given without parentIssueId", async () => {
    const { app, db } = createTestApp();
    const { projectId } = await seed(db);

    const res = await app.request("/api/issues/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        driveTarget: "Should be ignored",
        issues: [{ title: "Orphan" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.driveId).toBeUndefined();

    const drives = await db.select().from(schema.drives);
    expect(drives).toHaveLength(0);
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

describe("POST /api/issues/contract-coupled", () => {
  it("rewires external sequential dependencies onto the lead and removes internal coupling", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId, cancelledStatusId } = await seed(db);
    const lead = await insertIssue(db, projectId, statusId, 1);
    const member = await insertIssue(db, projectId, statusId, 2);
    const externalA = await insertIssue(db, projectId, statusId, 3);
    const externalB = await insertIssue(db, projectId, statusId, 4);
    await insertDependency(db, lead, member, "coupled_with");
    await insertDependency(db, member, externalA, "depends_on");
    await insertDependency(db, externalB, member, "blocked_by");

    const res = await app.request("/api/issues/contract-coupled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [lead, member], leadIssueId: lead }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.leadIssueId).toBe(lead);
    expect(body.memberIssueIds.sort()).toEqual([lead, member].sort());
    expect(body.added).toBe(3);
    expect(body.removed).toBe(3);

    const deps = await db.select().from(schema.issueDependencies);
    expect(deps.map((dep) => ({ issueId: dep.issueId, dependsOnId: dep.dependsOnId, type: dep.type })).sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`))).toEqual([
      { issueId: member, dependsOnId: lead, type: "duplicates" },
      { issueId: externalB, dependsOnId: lead, type: "blocked_by" },
      { issueId: lead, dependsOnId: externalA, type: "depends_on" },
    ].sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`)));

    const issues = await db.select().from(schema.issues).where(inArray(schema.issues.id, [lead, member]));
    const updatedLead = issues.find((issue) => issue.id === lead);
    const absorbedMember = issues.find((issue) => issue.id === member);
    expect(updatedLead?.description).toContain(`### From #1: I1`);
    expect(updatedLead?.description).toContain(`### From #2: I2`);
    expect(absorbedMember?.statusId).toBe(cancelledStatusId);
    expect(absorbedMember?.description).toContain("Absorbed into #1");
  });

  it("rejects selection that omits part of the coupled component", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const a = await insertIssue(db, projectId, statusId, 1);
    const b = await insertIssue(db, projectId, statusId, 2);
    const c = await insertIssue(db, projectId, statusId, 3);
    await insertDependency(db, a, b, "coupled_with");
    await insertDependency(db, b, c, "coupled_with");

    const res = await app.request("/api/issues/contract-coupled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [a, b], leadIssueId: a }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("exactly match");
  });

  it("rejects cross-project contraction", async () => {
    const { app, db } = createTestApp();
    const first = await seed(db);
    const second = await seed(db);
    const a = await insertIssue(db, first.projectId, first.statusId, 1);
    const b = await insertIssue(db, second.projectId, second.statusId, 1);

    const res = await app.request("/api/issues/contract-coupled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [a, b], leadIssueId: a }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("across projects");
  });

  it("rolls back when inherited dependencies would create a cycle", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const lead = await insertIssue(db, projectId, statusId, 1);
    const member = await insertIssue(db, projectId, statusId, 2);
    const external = await insertIssue(db, projectId, statusId, 3);
    await insertDependency(db, lead, member, "coupled_with");
    await insertDependency(db, member, external, "depends_on");
    await insertDependency(db, external, lead, "depends_on");

    const res = await app.request("/api/issues/contract-coupled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [lead, member], leadIssueId: lead }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("cycle");

    const deps = await db.select().from(schema.issueDependencies);
    expect(deps.map((dep) => ({ issueId: dep.issueId, dependsOnId: dep.dependsOnId, type: dep.type })).sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`))).toEqual([
      { issueId: external, dependsOnId: lead, type: "depends_on" },
      { issueId: lead, dependsOnId: member, type: "coupled_with" },
      { issueId: member, dependsOnId: external, type: "depends_on" },
    ].sort((a, b) => `${a.issueId}${a.dependsOnId}${a.type}`.localeCompare(`${b.issueId}${b.dependsOnId}${b.type}`)));
  });
});

describe("PATCH /api/issues/bulk", () => {
  it("updates priority, estimate, and due date for multiple issues in one request", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seed(db);
    const a = await insertIssue(db, projectId, statusId, 1);
    const b = await insertIssue(db, projectId, statusId, 2);

    const res = await app.request("/api/issues/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueIds: [a, b],
        updates: { priority: "critical", estimate: "L", dueDate: "2026-06-15" },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ updated: 2 });

    const rows = await db.select().from(schema.issues);
    expect(rows.map((row) => ({
      priority: row.priority,
      estimate: row.estimate,
      dueDate: row.dueDate,
    }))).toEqual([
      { priority: "critical", estimate: "L", dueDate: "2026-06-15" },
      { priority: "critical", estimate: "L", dueDate: "2026-06-15" },
    ]);
  });
});

describe("POST /api/issues/archive-done", () => {
  async function seedWithStatuses(db: TestDb) {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    const todoId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: todoId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
    });
    const doneId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: doneId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now,
    });
    const archivedId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: archivedId, projectId, name: "Archived", sortOrder: 99, isDefault: false, createdAt: now,
    });
    return { projectId, todoId, doneId, archivedId };
  }

  async function insertIssueWithStatus(
    db: TestDb,
    projectId: string,
    statusId: string,
    num: number,
    statusChangedAt: string,
  ) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id, issueNumber: num, title: `I${num}`, priority: "medium",
      sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
      statusChangedAt,
    });
    return id;
  }

  it("archives exactly the Done issues older than the threshold and leaves newer ones", async () => {
    const { app, db } = createTestApp();
    const { projectId, doneId, archivedId } = await seedWithStatuses(db);
    const now = new Date("2026-06-04T12:00:00.000Z");

    // Exactly at cutoff (30 days old) — should NOT be archived (strict older than)
    const atCutoff = await insertIssueWithStatus(
      db, projectId, doneId, 1,
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );

    // 1 ms before cutoff — should NOT be archived
    const justUnder = await insertIssueWithStatus(
      db, projectId, doneId, 2,
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 + 1).toISOString(),
    );

    // 1 ms after cutoff — should be archived
    const justOver = await insertIssueWithStatus(
      db, projectId, doneId, 3,
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1).toISOString(),
    );

    // 60 days old — should be archived
    const old = await insertIssueWithStatus(
      db, projectId, doneId, 4,
      new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const res = await app.request("/api/issues/archive-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, olderThanDays: 30, nowOverride: now.toISOString() }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.archived).toBe(2);

    const rows = await db.select({ id: schema.issues.id, statusId: schema.issues.statusId })
      .from(schema.issues);
    const statusById = new Map(rows.map((r) => [r.id, r.statusId]));

    // Not archived — still Done
    expect(statusById.get(atCutoff)).toBe(doneId);
    expect(statusById.get(justUnder)).toBe(doneId);

    // Archived
    expect(statusById.get(justOver)).toBe(archivedId);
    expect(statusById.get(old)).toBe(archivedId);
  });

  it("returns 0 when no Done issues exceed the threshold", async () => {
    const { app, db } = createTestApp();
    const { projectId, doneId } = await seedWithStatuses(db);
    const now = new Date("2026-06-04T12:00:00.000Z");

    // Issue 1 day old
    await insertIssueWithStatus(
      db, projectId, doneId, 1,
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );

    const res = await app.request("/api/issues/archive-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, olderThanDays: 30, nowOverride: now.toISOString() }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ archived: 0 });
  });

  it("returns 400 for invalid olderThanDays", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/issues/archive-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: randomUUID(), olderThanDays: -5 }),
    });
    expect(res.status).toBe(400);
  });
});
