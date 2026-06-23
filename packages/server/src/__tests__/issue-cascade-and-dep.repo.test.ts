import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  deleteIssueCascade,
  getDependencyEdge,
  insertDependency,
} from "../repositories/issue-service.repository.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";

// Regression tests for the two CLI bugs filed in #857 / #858:
// - #858: issue delete omitted issue-scoped children that FK issues.id.
// - #857: duplicate dependency detection relied on driver-specific error text.

async function seedProjectWithStatus(db: TestDb): Promise<{ projectId: string; statusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Cascade Project",
    repoPath: `C:/tmp/${projectId}`,
    repoName: "cascade-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id, issueNumber, title: `Issue ${issueNumber}`, description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedWorkspace(db: TestDb, issueId: string): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: `feature/${id}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function expectForeignKeysEnabled(client: ReturnType<typeof createTestDb>["client"]): Promise<void> {
  const result = await client.execute("PRAGMA foreign_keys");
  expect(Number(result.rows[0]?.foreign_keys ?? 0)).toBe(1);
}

async function expectNoForeignKeyViolations(client: ReturnType<typeof createTestDb>["client"]): Promise<void> {
  const result = await client.execute("PRAGMA foreign_key_check");
  expect(result.rows).toEqual([]);
}

async function seedWorkspaceChildren(db: TestDb, projectId: string, issueId: string, workspaceId: string): Promise<string> {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId, workspaceId, status: "running", startedAt: now,
  });
  await db.insert(schema.sessionMessages).values({
    sessionId, type: "stdout", data: "hello", createdAt: now,
  });
  await db.insert(schema.diffComments).values({
    id: randomUUID(), workspaceId, filePath: "src/file.ts", side: "new", body: "comment", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.issueArtifacts).values({
    id: randomUUID(), issueId, workspaceId, type: "text", content: "workspace artifact", createdAt: now,
  });
  await db.insert(schema.issueComments).values({
    id: randomUUID(), issueId, workspaceId, kind: "note", author: "agent", body: "workspace comment", createdAt: now,
  });
  await db.insert(schema.repos).values({
    id: randomUUID(), workspaceId, projectId, path: `C:/tmp/${workspaceId}`, createdAt: now,
  });
  await db.insert(schema.testRetryDecisions).values({
    id: randomUUID(),
    sessionId,
    workspaceId,
    testName: "fails sometimes",
    decision: "flake",
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workflowTransitions).values({
    id: randomUUID(), workspaceId, toNodeId: "review", summary: "advanced", triggeredBy: "agent", createdAt: now,
  });
  return sessionId;
}

describe("deleteIssueCascade (#858 - FK-safe issue delete)", () => {
  let db: TestDb;
  let client: ReturnType<typeof createTestDb>["client"];
  beforeEach(() => {
    ({ client, db } = createTestDb());
  });

  it("enables foreign key enforcement in test databases", async () => {
    await expectForeignKeysEnabled(client);
  });

  it("deletes an issue and leaves no orphans across issue/workspace-referencing tables", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const issueId = await seedIssue(db, projectId, statusId, 1);
    const otherId = await seedIssue(db, projectId, statusId, 2);
    const workspaceId = await seedWorkspace(db, issueId);
    const sessionId = await seedWorkspaceChildren(db, projectId, issueId, workspaceId);
    const now = new Date().toISOString();

    await expectForeignKeysEnabled(client);
    await db.insert(schema.issueArtifacts).values({
      id: randomUUID(), issueId, workspaceId: null, type: "text", content: "direct artifact", createdAt: now,
    });
    await db.insert(schema.issueComments).values({
      id: randomUUID(), issueId, workspaceId: null, kind: "note", author: "user", body: "issue-level comment", createdAt: now,
    });
    await db.insert(schema.issueTimeEntries).values({
      id: randomUUID(), issueId, minutes: 15, note: null, createdAt: now,
    });
    await db.insert(schema.showdowns).values({
      id: randomUUID(), issueId, status: "active", createdAt: now, updatedAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId, dependsOnId: otherId, type: "depends_on", createdAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: otherId, dependsOnId: issueId, type: "blocked_by", createdAt: now,
    });

    await expect(deleteIssueCascade(issueId, db)).resolves.toBeUndefined();

    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.showdowns).where(eq(schema.showdowns.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueDependencies)
      .where(or(eq(schema.issueDependencies.issueId, issueId), eq(schema.issueDependencies.dependsOnId, issueId)))).toHaveLength(0);
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, otherId))).toHaveLength(1);
    await expectNoForeignKeyViolations(client);
  });

  it("deletes an issue with no children", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const issueId = await seedIssue(db, projectId, statusId, 1);
    await expect(deleteIssueCascade(issueId, db)).resolves.toBeUndefined();
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issueId))).toHaveLength(0);
    await expectNoForeignKeyViolations(client);
  });
});

describe("deleteWorkspaceCascade (FK-safe workspace delete)", () => {
  let db: TestDb;
  let client: ReturnType<typeof createTestDb>["client"];
  beforeEach(() => {
    ({ client, db } = createTestDb());
  });

  it("deletes every table that references the workspace or its sessions", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const issueId = await seedIssue(db, projectId, statusId, 1);
    const workspaceId = await seedWorkspace(db, issueId);
    const sessionId = await seedWorkspaceChildren(db, projectId, issueId, workspaceId);

    await expectForeignKeysEnabled(client);
    await expect(deleteWorkspaceCascade(workspaceId, db)).resolves.toBeUndefined();

    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issueId))).toHaveLength(1);
    await expectNoForeignKeyViolations(client);
  });
});

describe("getDependencyEdge (#857 - driver-independent dup detection)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("returns null when no edge exists, and the row once inserted (matching issueId, dependsOnId, type)", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const a = await seedIssue(db, projectId, statusId, 1);
    const b = await seedIssue(db, projectId, statusId, 2);

    expect(await getDependencyEdge(a, b, "depends_on", db)).toBeNull();

    const edgeId = randomUUID();
    await insertDependency({ id: edgeId, issueId: a, dependsOnId: b, type: "depends_on", createdAt: new Date().toISOString() }, db);

    const found = await getDependencyEdge(a, b, "depends_on", db);
    expect(found?.id).toBe(edgeId);

    expect(await getDependencyEdge(a, b, "blocked_by", db)).toBeNull();
    expect(await getDependencyEdge(b, a, "depends_on", db)).toBeNull();
  });
});
