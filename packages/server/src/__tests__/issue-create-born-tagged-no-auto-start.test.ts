import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssueWithNextNumber } from "../repositories/issue/cli-commands.repository.js";
import { hasSkipAutoStartTag } from "../repositories/auto-start.repository.js";
import { SKIP_AUTO_START_TAG } from "../repositories/wip-capacity.repository.js";

const NOW = "2026-09-26T09:00:00.000Z";

/**
 * #1254: creating an issue and tagging it `no-auto-start` used to take two calls — the CLI
 * `issue create` had no tag option, and tags attached via a follow-up `POST /:id/tags`. A
 * monitor-mode project with free WIP could auto-start the issue in between (#1232, #1253).
 * `createIssueWithNextNumber` now accepts `tags` and applies them in the SAME transaction
 * as the issue insert, so the monitor's `hasSkipAutoStartTag` gate can never observe the
 * issue before it is tagged.
 */
async function seed(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "tag-race-1254", repoPath: "/tmp/tag-race-1254", repoName: "tag-race-1254",
    defaultBranch: "main", createdAt: NOW, updatedAt: NOW,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: NOW,
  });
  return { projectId, statusId };
}

describe("createIssueWithNextNumber — born-tagged (#1254)", () => {
  it("applies --tag no-auto-start atomically, so a monitor auto-start pass run immediately after create skips it", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);

    const { id } = await createIssueWithNextNumber({
      projectId, statusId, title: "Maintenance window ticket",
      tags: [SKIP_AUTO_START_TAG],
    }, db);

    // The tag is visible in the SAME read the monitor's gate chain uses — no window where
    // the issue exists untagged.
    expect(await hasSkipAutoStartTag(id, SKIP_AUTO_START_TAG, db)).toBe(true);
  });

  it("creates an unknown tag name on the fly", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);

    const { id } = await createIssueWithNextNumber({
      projectId, statusId, title: "Custom tag ticket", tags: ["brand-new-tag"],
    }, db);

    const rows = await db.select({ name: schema.tags.name })
      .from(schema.issueTags)
      .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
      .where(eq(schema.issueTags.issueId, id));
    expect(rows.map((r) => r.name)).toEqual(["brand-new-tag"]);
  });

  it("reuses an EXISTING tag case-insensitively instead of creating a duplicate", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);
    const existingTagId = randomUUID();
    await db.insert(schema.tags).values({ id: existingTagId, name: SKIP_AUTO_START_TAG, color: null, createdAt: NOW });

    const { id } = await createIssueWithNextNumber({
      projectId, statusId, title: "Reuses builtin tag", tags: ["No-Auto-Start"],
    }, db);

    const rows = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tagId).toBe(existingTagId);
    expect(await hasSkipAutoStartTag(id, SKIP_AUTO_START_TAG, db)).toBe(true);
    const allTags = await db.select().from(schema.tags);
    expect(allTags.filter((t) => t.name.toLowerCase() === SKIP_AUTO_START_TAG)).toHaveLength(1);
  });

  it("omitting tags applies none (unchanged default behavior)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seed(db);

    const { id } = await createIssueWithNextNumber({ projectId, statusId, title: "Plain ticket" }, db);

    expect(await hasSkipAutoStartTag(id, SKIP_AUTO_START_TAG, db)).toBe(false);
  });
});
