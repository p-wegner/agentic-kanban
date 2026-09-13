import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import { isDriveOrEpicMeta, notDriveOrEpicMetaSql } from "../startup/monitor-auto-start.js";
import { projects, projectStatuses, issues, drives, issueDependencies, tags, issueTags } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";

const now = "2026-06-15T00:00:00.000Z";

async function seedIssue(db: ReturnType<typeof createTestDb>["db"], projectId: string, statusId: string, id: string, num: number) {
  await db.insert(issues).values({ id, issueNumber: num, title: `Issue ${num}`, statusId, projectId, createdAt: now, updatedAt: now });
}

async function tagIssue(db: ReturnType<typeof createTestDb>["db"], issueId: string, tagName: string) {
  const existing = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, tagName)).limit(1);
  const tagId = existing[0]?.id ?? randomUUID();
  if (existing.length === 0) {
    await db.insert(tags).values({ id: tagId, name: tagName, isBuiltin: true, createdAt: now });
  }
  await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId });
}

describe("isDriveOrEpicMeta (#824) — a drive/epic meta must not be auto-started as a builder", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = "proj-1";
    statusId = "status-backlog";
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Backlog", createdAt: now });
  });

  it("true when the issue is a Drive record's metaIssueId", async () => {
    await seedIssue(db, projectId, statusId, "meta-1", 1);
    await db.insert(drives).values({ id: "drive-1", projectId, metaIssueId: "meta-1", target: "Finish the epic", status: "active", startedAt: now });
    expect(await isDriveOrEpicMeta("meta-1", db)).toBe(true);
  });

  it("true when the issue is a parent_of another issue (epic with children)", async () => {
    await seedIssue(db, projectId, statusId, "epic-1", 1);
    await seedIssue(db, projectId, statusId, "child-1", 2);
    await db.insert(issueDependencies).values({ id: "dep-1", issueId: "epic-1", dependsOnId: "child-1", type: "parent_of", createdAt: now });
    expect(await isDriveOrEpicMeta("epic-1", db)).toBe(true);
    // The child itself is NOT a meta.
    expect(await isDriveOrEpicMeta("child-1", db)).toBe(false);
  });

  it("true for the parent target of a child_of edge", async () => {
    await seedIssue(db, projectId, statusId, "epic-2", 1);
    await seedIssue(db, projectId, statusId, "child-2", 2);
    await db.insert(issueDependencies).values({ id: "dep-2", issueId: "child-2", dependsOnId: "epic-2", type: "child_of", createdAt: now });
    expect(await isDriveOrEpicMeta("epic-2", db)).toBe(true);
  });

  it("false for an ordinary leaf issue (no drive, no children)", async () => {
    await seedIssue(db, projectId, statusId, "leaf-1", 1);
    expect(await isDriveOrEpicMeta("leaf-1", db)).toBe(false);
  });

  it("notDriveOrEpicMetaSql excludes metas from the candidate query but keeps leaves (real DB)", async () => {
    await seedIssue(db, projectId, statusId, "epic", 1);
    await seedIssue(db, projectId, statusId, "leaf-a", 2);
    await seedIssue(db, projectId, statusId, "leaf-b", 3);
    await db.insert(issueDependencies).values({ id: "d1", issueId: "epic", dependsOnId: "leaf-a", type: "parent_of", createdAt: now });
    await db.insert(drives).values({ id: "drv", projectId, metaIssueId: "leaf-b", target: "x", status: "active", startedAt: now });

    // The actual candidate-query filter, run against a real SQLite DB.
    const rows = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.projectId, projectId), notDriveOrEpicMetaSql()));
    const ids = rows.map((r) => r.id).sort();
    // epic (parent_of) and leaf-b (drive meta) are excluded; only the plain leaf-a remains.
    expect(ids).toEqual(["leaf-a"]);
  });

  describe("#1134 — an epic-tagged issue with NO children and NO drive row", () => {
    it("true: a freshly planned, never-decomposed drive epic must not be auto-started", async () => {
      await seedIssue(db, projectId, statusId, "undecomposed-epic", 1);
      await tagIssue(db, "undecomposed-epic", "epic");
      expect(await isDriveOrEpicMeta("undecomposed-epic", db)).toBe(true);
    });

    it("false: a decomposer verdict of right-sized makes it startable again (#1074)", async () => {
      await seedIssue(db, projectId, statusId, "right-sized-epic", 1);
      await tagIssue(db, "right-sized-epic", "epic");
      await tagIssue(db, "right-sized-epic", "right-sized");
      expect(await isDriveOrEpicMeta("right-sized-epic", db)).toBe(false);
    });

    it("false: a non-epic childless issue is unaffected (regression)", async () => {
      await seedIssue(db, projectId, statusId, "ordinary-todo", 1);
      expect(await isDriveOrEpicMeta("ordinary-todo", db)).toBe(false);
    });

    it("notDriveOrEpicMetaSql excludes the undecomposed epic but keeps the right-sized one and an ordinary issue (real DB)", async () => {
      await seedIssue(db, projectId, statusId, "undecomposed-epic", 1);
      await tagIssue(db, "undecomposed-epic", "epic");

      await seedIssue(db, projectId, statusId, "right-sized-epic", 2);
      await tagIssue(db, "right-sized-epic", "epic");
      await tagIssue(db, "right-sized-epic", "right-sized");

      await seedIssue(db, projectId, statusId, "ordinary-todo", 3);

      const rows = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.projectId, projectId), notDriveOrEpicMetaSql()));
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual(["ordinary-todo", "right-sized-epic"]);
    });
  });
});
