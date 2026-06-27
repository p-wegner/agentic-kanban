// @covers issues-board.config.statuses [error, state-transition]
/**
 * Gap (issues-board.config.statuses, PARTIAL → error/state-transition): the
 * data-integrity guard that prevents orphaning live issues — DELETE of a project
 * status that still has linked issues must be REFUSED with 409 (no orphaned
 * issues) — had no asserting test. Only GET/POST happy paths were covered.
 *
 * The guard lives in deleteProjectStatus (project.repository.ts:~224); the
 * service maps its {status:409} into a CONFLICT ProjectError. We assert the
 * repository contract directly (the exact evidence line) plus the selective flip:
 * once the issue no longer references the status, the delete succeeds.
 *
 * Mutation note: deleting the `if (linkedIssues.length > 0)` block makes the
 * first delete return {success:true} and drop the status while #1 still points at
 * it → the 409 assertion AND the "status still exists" assertion go RED.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { deleteProjectStatus } from "../repositories/project.repository.js";

let db: TestDb;
let projectId: string;
let todoStatusId: string;
let doneStatusId: string;

async function statusExists(statusId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.projectStatuses.id })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.id, statusId))
    .limit(1);
  return rows.length > 0;
}

async function seedIssue(issueNumber: number, statusId: string): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id,
    issueNumber,
    title: `Issue ${issueNumber}`,
    statusId,
    projectId,
    skipAutoReview: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

beforeEach(async () => {
  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Status Guard Test",
    repoPath: "/tmp/sg",
    repoName: "sg",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  todoStatusId = randomUUID();
  doneStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
});

describe("deleteProjectStatus — linked-issue guard (issues-board.config.statuses)", () => {
  it("REFUSES to delete a status with a linked issue (409, message) and leaves the status intact", async () => {
    const issueId = await seedIssue(1, todoStatusId);

    const result = await deleteProjectStatus(projectId, todoStatusId, db);

    // 409 with the data-integrity message — never a silent success.
    expect(result).toEqual({ error: "Cannot delete status with linked issues", status: 409 });

    // State unchanged: the status still exists AND the issue is not orphaned.
    expect(await statusExists(todoStatusId)).toBe(true);
    const issueRow = await db
      .select({ statusId: schema.issues.statusId })
      .from(schema.issues)
      .where(eq(schema.issues.id, issueId))
      .limit(1);
    expect(issueRow[0].statusId).toBe(todoStatusId);
  });

  it("ALLOWS the delete once the issue is moved off the status (selective: guard only fires while linked)", async () => {
    const issueId = await seedIssue(1, todoStatusId);

    // Still blocked while linked.
    expect(await deleteProjectStatus(projectId, todoStatusId, db)).toMatchObject({ status: 409 });

    // Move the issue to another column — the status now has no linked issues.
    await db.update(schema.issues).set({ statusId: doneStatusId }).where(eq(schema.issues.id, issueId));

    const result = await deleteProjectStatus(projectId, todoStatusId, db);
    expect(result).toEqual({ success: true });
    expect(await statusExists(todoStatusId)).toBe(false);
  });

  it("ALLOWS the delete once the linked issue is deleted", async () => {
    const issueId = await seedIssue(1, todoStatusId);
    expect(await deleteProjectStatus(projectId, todoStatusId, db)).toMatchObject({ status: 409 });

    await db.delete(schema.issues).where(eq(schema.issues.id, issueId));

    expect(await deleteProjectStatus(projectId, todoStatusId, db)).toEqual({ success: true });
    expect(await statusExists(todoStatusId)).toBe(false);
  });
});
