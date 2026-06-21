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

// Regression tests for the two CLI bugs filed in #857 / #858:
//  - #858: `issue delete` cascade omitted issue-scoped children that FK issues.id
//          (direct artifacts with workspaceId NULL, issue-level comments, time
//          entries, showdowns, and dependency edges in BOTH directions). Those FKs
//          are RESTRICT in real DBs, so the final issue-row delete FK-failed.
//  - #857: duplicate dependency detection relied on matching "UNIQUE constraint" in
//          the driver error string, which libsql does not emit. getDependencyEdge
//          gives a driver-independent pre-insert check.

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

describe("deleteIssueCascade (#858 — FK-safe issue delete)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("deletes an issue that has direct artifacts, issue-level comments, time entries, showdowns and dependency edges (both directions)", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const issueId = await seedIssue(db, projectId, statusId, 1);
    const otherId = await seedIssue(db, projectId, statusId, 2);
    const now = new Date().toISOString();

    // Children attached DIRECTLY to the issue (workspaceId NULL) — these are the
    // rows the old cascade leaked because it only cleared workspace-scoped rows.
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
    // Outgoing edge (issue depends on other) AND incoming edge (other depends on issue).
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId, dependsOnId: otherId, type: "depends_on", createdAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: otherId, dependsOnId: issueId, type: "blocked_by", createdAt: now,
    });

    // Must not throw (the old cascade FK-failed on the final issue-row delete).
    await expect(deleteIssueCascade(issueId, db)).resolves.toBeUndefined();

    // The issue and every one of its scoped children are gone.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.showdowns).where(eq(schema.showdowns.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(schema.issueDependencies)
      .where(or(eq(schema.issueDependencies.issueId, issueId), eq(schema.issueDependencies.dependsOnId, issueId)))).toHaveLength(0);

    // The unrelated issue survives.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, otherId))).toHaveLength(1);
  });

  it("deletes an issue with no children", async () => {
    const { projectId, statusId } = await seedProjectWithStatus(db);
    const issueId = await seedIssue(db, projectId, statusId, 1);
    await expect(deleteIssueCascade(issueId, db)).resolves.toBeUndefined();
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, issueId))).toHaveLength(0);
  });
});

describe("getDependencyEdge (#857 — driver-independent dup detection)", () => {
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

    // A different type between the same pair is NOT a duplicate (unique key includes type).
    expect(await getDependencyEdge(a, b, "blocked_by", db)).toBeNull();
    // Direction matters.
    expect(await getDependencyEdge(b, a, "depends_on", db)).toBeNull();
  });
});
