/**
 * #827 — REST epic-seeding (decompose/confirm) creates child_of edges and
 * optionally auto-creates a Drive record so reconcileDriveCompletion engages.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { confirmEpicDecomposition } from "../services/issue-ai.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

async function insertIssue(db: Db, projectId: string, statusId: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber: 1, title: "Meta epic", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("confirmEpicDecomposition — child_of edges and Drive creation", () => {
  it("creates child_of edges (dependsOnId=parent) alongside parent_of edges", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const parentId = await insertIssue(db, projectId, statusId);

    const result = await confirmEpicDecomposition(
      {
        issueId: parentId,
        projectId,
        children: [
          { tempId: "t1", title: "Child 1", priority: "medium" },
          { tempId: "t2", title: "Child 2", priority: "medium" },
        ],
        dependencies: [],
      },
      db as any,
    );

    expect(result.createdIssues).toHaveLength(2);

    const childIds = result.createdIssues.map((c) => c.id);

    // child_of edges: child.issueId → dependsOnId=parent (what reconcileDriveCompletion queries)
    const childOfEdges = await db
      .select()
      .from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.dependsOnId, parentId), eq(schema.issueDependencies.type, "child_of")));
    expect(childOfEdges).toHaveLength(2);
    expect(childOfEdges.map((e) => e.issueId).sort()).toEqual(childIds.sort());

    // parent_of edges: parent.issueId → dependsOnId=child (still created for UI)
    const parentOfEdges = await db
      .select()
      .from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.issueId, parentId), eq(schema.issueDependencies.type, "parent_of")));
    expect(parentOfEdges).toHaveLength(2);
  });

  it("auto-creates an active Drive with metaIssueId when driveTarget is provided", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const parentId = await insertIssue(db, projectId, statusId);

    const result = await confirmEpicDecomposition(
      {
        issueId: parentId,
        projectId,
        children: [{ tempId: "t1", title: "Subtask", priority: "medium" }],
        dependencies: [],
        driveTarget: "Ship the epic",
      },
      db as any,
    );

    expect(result.driveId).toBeTruthy();

    const drives = await db
      .select()
      .from(schema.drives)
      .where(eq(schema.drives.id, result.driveId!));
    expect(drives).toHaveLength(1);
    expect(drives[0].metaIssueId).toBe(parentId);
    expect(drives[0].target).toBe("Ship the epic");
    expect(drives[0].status).toBe("active");
  });

  it("does not create a Drive when driveTarget is omitted", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const parentId = await insertIssue(db, projectId, statusId);

    const result = await confirmEpicDecomposition(
      {
        issueId: parentId,
        projectId,
        children: [{ tempId: "t1", title: "Subtask", priority: "medium" }],
        dependencies: [],
      },
      db as any,
    );

    expect(result.driveId).toBeUndefined();
    const drives = await db.select().from(schema.drives);
    expect(drives).toHaveLength(0);
  });
});
