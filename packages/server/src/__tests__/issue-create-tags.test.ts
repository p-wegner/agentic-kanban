import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { TestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";

const NOW = "2026-09-12T09:00:00.000Z";

/**
 * #1108 gap 3: a ticket must be able to be born already tagged (e.g. `no-auto-start`), so
 * "file it for a maintenance window" does not have to win a race against the monitor
 * provisioning a workspace before a follow-up `POST /:id/tags` call lands.
 */
async function seed(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "tag-race", repoPath: "/tmp/tag-race", repoName: "tag-race",
    defaultBranch: "main", createdAt: NOW, updatedAt: NOW,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: NOW,
  });
  return { projectId, statusId };
}

async function tagNamesOf(db: TestDb, issueId: string): Promise<string[]> {
  const rows = await db.select({ name: schema.tags.name })
    .from(schema.issueTags)
    .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
    .where(eq(schema.issueTags.issueId, issueId));
  return rows.map((r) => r.name).sort();
}

describe("createIssue — born-tagged (#1108)", () => {
  it("applies requested tag names, creating an unknown tag on the fly", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);
    const service = createIssueService({ database: db });

    const created = await service.createIssue({
      projectId, title: "Maintenance window ticket", statusId,
      tags: ["no-auto-start", "brand-new-tag"],
    });

    expect(await tagNamesOf(db, created.id)).toEqual(["brand-new-tag", "no-auto-start"]);
  });

  it("reuses an EXISTING tag case-insensitively instead of creating a duplicate", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);
    const existingTagId = randomUUID();
    await db.insert(schema.tags).values({ id: existingTagId, name: "no-auto-start", color: null, createdAt: NOW });

    const service = createIssueService({ database: db });
    const created = await service.createIssue({
      projectId, title: "Reuses builtin tag", statusId, tags: ["No-Auto-Start"],
    });

    const rows = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tagId).toBe(existingTagId);
    // No second "no-auto-start" tag row was minted.
    expect((await db.select().from(schema.tags).where(eq(schema.tags.name, "no-auto-start")))).toHaveLength(1);
  });

  it("noAutoStart:true is shorthand for tags:['no-auto-start']", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);
    const service = createIssueService({ database: db });

    const created = await service.createIssue({
      projectId, title: "Shorthand", statusId, noAutoStart: true,
    });

    expect(await tagNamesOf(db, created.id)).toEqual(["no-auto-start"]);
  });

  it("omitting tags/noAutoStart applies none (unchanged default behavior)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);
    const service = createIssueService({ database: db });

    const created = await service.createIssue({ projectId, title: "Plain ticket", statusId });

    expect(await tagNamesOf(db, created.id)).toEqual([]);
  });
});
