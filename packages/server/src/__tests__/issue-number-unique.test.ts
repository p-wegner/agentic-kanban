import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb, name: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name}`,
    repoName: name,
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  return { projectId, statusId };
}

function issueValues(projectId: string, statusId: string, issueNumber: number | null) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    issueNumber,
    title: `Issue ${issueNumber ?? "legacy"}`,
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  };
}

describe("issue number uniqueness", () => {
  it("enforces unique issue numbers within a project", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Unique Number Project");

    await db.insert(schema.issues).values(issueValues(projectId, statusId, 1));

    await expect(
      db.insert(schema.issues).values(issueValues(projectId, statusId, 1)),
    ).rejects.toThrow();
  });

  it("allows the same issue number in different projects", async () => {
    const { db } = createTestDb();
    const projectA = await seedProject(db, "Project A");
    const projectB = await seedProject(db, "Project B");

    await db.insert(schema.issues).values(issueValues(projectA.projectId, projectA.statusId, 1));
    await expect(
      db.insert(schema.issues).values(issueValues(projectB.projectId, projectB.statusId, 1)),
    ).resolves.toBeDefined();
  });

  it("keeps legacy null issue numbers insertable", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Legacy Number Project");

    await db.insert(schema.issues).values(issueValues(projectId, statusId, null));
    await expect(
      db.insert(schema.issues).values(issueValues(projectId, statusId, null)),
    ).resolves.toBeDefined();
  });
});
