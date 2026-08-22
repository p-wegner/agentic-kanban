import { describe, it, expect } from "vitest";
import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  insertIssueComment,
  getIssueCommentsPage,
  ISSUE_COMMENT_PAGE_LIMIT,
  ISSUE_COMMENT_PAGE_LIMIT_MAX,
} from "../repositories/issue-comments.repository.js";
import { getIssueActivityComments, ISSUE_ACTIVITY_COMMENT_LIMIT } from "../repositories/issue-activity.repository.js";
import { createIssueCommentsService } from "../services/issue-comments.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedIssue(db: Db) {
  await db.insert(projects).values({ id: "proj-1", name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: "status-1", projectId: "proj-1", name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  await db.insert(issues).values({ id: "issue-1", issueNumber: 1, title: "T", statusId: "status-1", projectId: "proj-1" });
  return "issue-1";
}

/** `count` comments, each with a distinct body so the write-path dedup does not collapse them. */
async function seedComments(db: Db, issueId: string, count: number) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    await insertIssueComment(
      { issueId, kind: "note", author: "system", body: `body-${i}`, createdAt: new Date(base + i * 1000).toISOString() },
      db,
    );
  }
}

describe("issue comment read cap (#738)", () => {
  it("returns only the newest page, in ascending order, with paging metadata", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedComments(db, issueId, 25);

    const page = await getIssueCommentsPage(issueId, { limit: 10 }, db);
    expect(page.comments).toHaveLength(10);
    expect(page.totalCount).toBe(25);
    expect(page.hasMore).toBe(true);
    // Newest ten (15..24), presented oldest-first so existing readers render unchanged.
    expect(page.comments[0].body).toBe("body-15");
    expect(page.comments[9].body).toBe("body-24");
    expect(page.nextCursor).toBe(page.comments[0].createdAt);
  });

  it("pages further back with the keyset cursor and reports the end of the thread", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedComments(db, issueId, 25);

    const first = await getIssueCommentsPage(issueId, { limit: 10 }, db);
    const second = await getIssueCommentsPage(issueId, { limit: 10, before: first.nextCursor }, db);
    expect(second.comments[0].body).toBe("body-5");
    expect(second.comments[9].body).toBe("body-14");
    expect(second.hasMore).toBe(true);

    const third = await getIssueCommentsPage(issueId, { limit: 10, before: second.nextCursor }, db);
    expect(third.comments.map((r) => r.body)).toEqual(["body-0", "body-1", "body-2", "body-3", "body-4"]);
    expect(third.hasMore).toBe(false);
  });

  it("caps a caller-supplied limit so a query param cannot re-open the unbounded read", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedComments(db, issueId, 5);

    // No crash and no rejection — just a bounded read. The ceiling is what matters.
    expect(ISSUE_COMMENT_PAGE_LIMIT_MAX).toBeLessThanOrEqual(1000);
    expect(ISSUE_COMMENT_PAGE_LIMIT).toBeLessThanOrEqual(ISSUE_COMMENT_PAGE_LIMIT_MAX);
    const huge = await getIssueCommentsPage(issueId, { limit: 100_000 }, db);
    expect(huge.comments).toHaveLength(5);
    const nonsense = await getIssueCommentsPage(issueId, { limit: Number.NaN }, db);
    expect(nonsense.comments).toHaveLength(5);
  });

  it("service listComments is capped by default", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedComments(db, issueId, ISSUE_COMMENT_PAGE_LIMIT + 7);
    const service = createIssueCommentsService({ database: db });

    const comments = await service.listComments(issueId);
    expect(comments).toHaveLength(ISSUE_COMMENT_PAGE_LIMIT);
    const page = await service.listCommentsPage(issueId);
    expect(page.totalCount).toBe(ISSUE_COMMENT_PAGE_LIMIT + 7);
    expect(page.hasMore).toBe(true);
  });

  it("the activity feed read is capped and does not select the payload column", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedComments(db, issueId, ISSUE_ACTIVITY_COMMENT_LIMIT + 3);

    const rows = await getIssueActivityComments(issueId, db);
    expect(rows).toHaveLength(ISSUE_ACTIVITY_COMMENT_LIMIT);
    expect(rows[0]).not.toHaveProperty("payload");
  });
});
