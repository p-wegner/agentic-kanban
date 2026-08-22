import { describe, it, expect } from "vitest";
import { projects, projectStatuses, issues, workspaces, issueComments } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { insertIssueComment, getIssueComments } from "../repositories/issue-comments.repository.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedIssue(db: Db) {
  await db.insert(projects).values({ id: "proj-1", name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: "status-1", projectId: "proj-1", name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  await db.insert(issues).values({ id: "issue-1", issueNumber: 1, title: "T", statusId: "status-1", projectId: "proj-1" });
  await db.insert(workspaces).values({ id: "ws-1", issueId: "issue-1", branch: "feature/x", status: "active" });
  return "issue-1";
}

const at = (i: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString();

describe("issue-comment write-path dedup (#738)", () => {
  it("collapses an identical machine comment into a repeat counter instead of a new row", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);

    for (let i = 0; i < 5; i++) {
      await insertIssueComment(
        { issueId, workspaceId: "ws-1", kind: "merge-attempt", author: "system", body: "blocked on #9", createdAt: at(i) },
        db,
      );
    }

    const rows = await getIssueComments(issueId, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].repeatCount).toBe(5);
    expect(rows[0].createdAt).toBe(at(0));
    expect(rows[0].lastRepeatedAt).toBe(at(4));
  });

  it("returns the collapsed row, so a caller reading the result still sees its comment", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const first = await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", createdAt: at(0) }, db);
    const second = await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", createdAt: at(1) }, db);
    expect(second.id).toBe(first.id);
    expect(second.body).toBe("same");
    expect(second.repeatCount).toBe(2);
  });

  it("only collapses against the NEWEST comment in the thread, so a recurring state stays legible", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    for (const [i, body] of ["A", "A", "B", "A"].entries()) {
      await insertIssueComment({ issueId, kind: "note", author: "system", body, createdAt: at(i) }, db);
    }
    const rows = await getIssueComments(issueId, db);
    expect(rows.map((r) => [r.body, r.repeatCount])).toEqual([["A", 2], ["B", 1], ["A", 1]]);
  });

  it("keeps threads separate by kind and by workspace", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await insertIssueComment({ issueId, kind: "note", author: "system", body: "x", createdAt: at(0) }, db);
    await insertIssueComment({ issueId, kind: "merge-attempt", author: "system", body: "x", createdAt: at(1) }, db);
    await insertIssueComment({ issueId, workspaceId: "ws-1", kind: "note", author: "system", body: "x", createdAt: at(2) }, db);
    expect(await getIssueComments(issueId, db)).toHaveLength(3);
  });

  it("never collapses a human comment", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await insertIssueComment({ issueId, kind: "note", author: "user", body: "ping", createdAt: at(0) }, db);
    await insertIssueComment({ issueId, kind: "note", author: "user", body: "ping", createdAt: at(1) }, db);
    const rows = await getIssueComments(issueId, db);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.repeatCount === 1)).toBe(true);
  });

  it("does not collapse when the payload differs, even with an identical body", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", payload: { n: 1 }, createdAt: at(0) }, db);
    await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", payload: { n: 2 }, createdAt: at(1) }, db);
    expect(await getIssueComments(issueId, db)).toHaveLength(2);
  });

  it("does not collapse an out-of-order backfill written before the row it matches", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", createdAt: at(5) }, db);
    await insertIssueComment({ issueId, kind: "note", author: "system", body: "same", createdAt: at(1) }, db);
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(rows).toHaveLength(2);
  });
});
