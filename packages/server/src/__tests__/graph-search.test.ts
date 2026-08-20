// @covers graph.search.serverSide [correctness, db]
//
// #370 — the graph payload stopped shipping `description` and search silently became title-only.
// The match now happens here, where the text lives, so the descriptions never cross the wire.
//
// The measurement that chose this shape: the client-side index the ticket sketched as option (b)
// was BUILT and measured at 364,380 gzipped bytes on the dev board — 5.9× the ~62,000-byte graph
// payload it was meant to protect, and larger than the 309,477 the ticket exists to beat.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { searchGraphIssueIds } from "../repositories/graph-search.repository.js";

async function seedProject() {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
  return { projectId, statusId };
}

async function seedIssue(projectId: string, statusId: string, title: string, description: string | null) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id, issueNumber: Math.floor(Math.random() * 100000), title, description, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("searchGraphIssueIds (#370)", () => {
  it("matches a term that appears ONLY in the description — the case a column-drop breaks", () => {
    return (async () => {
      const { projectId, statusId } = await seedProject();
      const id = await seedIssue(projectId, statusId, "Rebuild the merge queue", "the reconciler strands a sibling worktree");
      expect(await searchGraphIssueIds(projectId, "worktree", db)).toEqual([id]);
    })();
  });

  it("matches on the title too", async () => {
    const { projectId, statusId } = await seedProject();
    const id = await seedIssue(projectId, statusId, "Rebuild the merge queue", null);
    expect(await searchGraphIssueIds(projectId, "merge queue", db)).toEqual([id]);
  });

  it("is case-insensitive on both columns", async () => {
    const { projectId, statusId } = await seedProject();
    const id = await seedIssue(projectId, statusId, "Rebuild The Merge Queue", "A Sibling WORKTREE");
    expect(await searchGraphIssueIds(projectId, "worktree", db)).toEqual([id]);
    expect(await searchGraphIssueIds(projectId, "MERGE", db)).toEqual([id]);
  });

  it("survives a NULL description", async () => {
    // COALESCE, not a silent row-drop: an issue with no description must still match by title.
    const { projectId, statusId } = await seedProject();
    const id = await seedIssue(projectId, statusId, "No description here", null);
    expect(await searchGraphIssueIds(projectId, "description", db)).toEqual([id]);
  });

  it("does not leak across projects", async () => {
    const a = await seedProject();
    const b = await seedProject();
    await seedIssue(a.projectId, a.statusId, "alpha", "shared-term");
    await seedIssue(b.projectId, b.statusId, "beta", "shared-term");
    expect((await searchGraphIssueIds(a.projectId, "shared-term", db)).length).toBe(1);
  });

  it("treats LIKE metacharacters as literal text", async () => {
    // Otherwise a query of "%" would match every issue on the board, and "100%" would match
    // nothing it should.
    const { projectId, statusId } = await seedProject();
    const id = await seedIssue(projectId, statusId, "Coverage at 100% now", null);
    await seedIssue(projectId, statusId, "unrelated", "unrelated");
    expect(await searchGraphIssueIds(projectId, "100%", db)).toEqual([id]);
    expect(await searchGraphIssueIds(projectId, "%", db)).toEqual([id]);
  });

  it("returns nothing for an empty or whitespace query, without a table scan", async () => {
    const { projectId, statusId } = await seedProject();
    await seedIssue(projectId, statusId, "anything", "anything");
    expect(await searchGraphIssueIds(projectId, "", db)).toEqual([]);
    expect(await searchGraphIssueIds(projectId, "   ", db)).toEqual([]);
  });
});
