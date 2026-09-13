// #1136 — `POST /api/issues/batch` (and any other caller falling back to
// `getFirstProjectStatusId`) must land a new issue in the project's FIRST column by
// `sortOrder`/`isDefault`, not whatever row SQLite's query planner happens to return first.
//
// Observed on the operated board: six batch-created tickets with no `statusId` landed in
// "AI Reviewed" instead of "Backlog" because the fallback query was a bare
// `select(id).limit(1)` with no ORDER BY. This test seeds statuses whose INSERT order
// differs from their sortOrder — the shape that made the old bare-`limit(1)` query pass
// even though it had no defined ordering at all.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { TestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";
import { getFirstProjectStatusId } from "../repositories/issue-service.repository.js";
import { resolveNewIssueDefaults } from "../repositories/issue.repository.js";

const NOW = "2026-09-13T09:00:00.000Z";

/**
 * Seeds statuses in an order that DIFFERS from their sortOrder — "AI Reviewed" is inserted
 * first (so it would win a bare, unordered `limit(1)`), while "Backlog" is inserted last but
 * carries the lowest sortOrder and is marked isDefault. This is exactly the hand-reordered
 * shape the ticket calls out.
 */
async function seedReorderedProject(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "reordered", repoPath: "/tmp/reordered", repoName: "reordered",
    defaultBranch: "main", createdAt: NOW, updatedAt: NOW,
  });

  const aiReviewedId = randomUUID();
  const inProgressId = randomUUID();
  const backlogId = randomUUID();

  // Insert order: AI Reviewed, In Progress, Backlog — the OPPOSITE of sortOrder/board order.
  await db.insert(schema.projectStatuses).values({
    id: aiReviewedId, projectId, name: "AI Reviewed", sortOrder: 2, isDefault: false, createdAt: NOW,
  });
  await db.insert(schema.projectStatuses).values({
    id: inProgressId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: NOW,
  });
  await db.insert(schema.projectStatuses).values({
    id: backlogId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: NOW,
  });

  return { projectId, aiReviewedId, inProgressId, backlogId };
}

describe("batch/single issue create — default status is the first column, not stumbled upon (#1136)", () => {
  it("getFirstProjectStatusId returns the isDefault/lowest-sortOrder row regardless of insert order", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedReorderedProject(db);

    const resolved = await getFirstProjectStatusId(projectId, db);

    expect(resolved).toBe(backlogId);
  });

  it("a batch create with no statusId lands every issue in the project's first column by sortOrder", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedReorderedProject(db);
    const service = createIssueService({ database: db });

    const { issues } = await service.createIssuesBatch(projectId, [
      { title: "batch one" },
      { title: "batch two" },
    ]);

    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.statusId).toBe(backlogId);
    }
  });

  it("the single-issue create path (resolveNewIssueDefaults) shares the same ordering", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedReorderedProject(db);

    const defaults = await resolveNewIssueDefaults(projectId, undefined, db);

    expect(defaults.statusId).toBe(backlogId);
  });
});
