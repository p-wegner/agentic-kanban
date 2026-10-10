import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { buildTicketContextMarkdown } from "@agentic-kanban/shared/lib/ticket-context";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { hasMergeBeforeWorkspace, listCommentsSinceLastMerge } from "../repositories/issue-reopen.repository.js";

let db: TestDb;
let projectId: string;
let statusId: string;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function createIssue(): Promise<string> {
  const id = randomUUID();
  const now = iso(0);
  await db.insert(schema.issues).values({
    id, projectId, statusId, title: "t", issueNumber: Math.floor(Math.random() * 1e9), createdAt: now, updatedAt: now,
  } as typeof schema.issues.$inferInsert);
  return id;
}

async function createWorkspace(issueId: string, createdAt: string, mergedAt: string | null): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.workspaces).values({
    id, issueId, branch: `feature/ak-${id.slice(0, 6)}`, baseBranch: "master", status: mergedAt ? "closed" : "active",
    mergedAt, createdAt, updatedAt: createdAt,
  });
  return id;
}

async function comment(issueId: string, body: string, createdAt: string, kind = "note") {
  await db.insert(schema.issueComments).values({
    id: randomUUID(), issueId, kind, author: "user", body, createdAt,
  });
}

beforeAll(async () => {
  db = createTestDb().db;
  const now = iso(0);
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Done", sortOrder: 4, isDefault: false, createdAt: now,
  });
});

describe("reopen context (#1343)", () => {
  it("returns only notes added after the last merge", async () => {
    const issueId = await createIssue();
    await createWorkspace(issueId, iso(-5000), iso(-4000));
    await comment(issueId, "before merge", iso(-4500));
    await comment(issueId, "REOPENED: new evidence", iso(-1000));
    await comment(issueId, "merge noise", iso(-500), "merge-attempt");
    const got = await listCommentsSinceLastMerge(issueId, db);
    expect(got.map((c) => c.body)).toEqual(["REOPENED: new evidence"]);
  });

  it("returns nothing for an issue that never merged", async () => {
    const issueId = await createIssue();
    await comment(issueId, "plain note", iso(-1000));
    expect(await listCommentsSinceLastMerge(issueId, db)).toEqual([]);
  });

  it("treats a workspace created after an earlier merge as a reopen attempt", async () => {
    const issueId = await createIssue();
    await createWorkspace(issueId, iso(-5000), iso(-4000));
    const retry = await createWorkspace(issueId, iso(-1000), null);
    expect(await hasMergeBeforeWorkspace(issueId, retry, iso(-1000), db)).toBe(true);
  });

  it("is not a reopen when nothing merged before the workspace", async () => {
    const issueId = await createIssue();
    const first = await createWorkspace(issueId, iso(-5000), null);
    expect(await hasMergeBeforeWorkspace(issueId, first, iso(-5000), db)).toBe(false);
  });

  it("renders the reopen comments as a labelled section", () => {
    const md = buildTicketContextMarkdown({
      title: "x",
      reopenComments: [{ author: "user", body: "REOPENED: still broken", createdAt: "2026-10-10T00:00:00Z" }],
    });
    expect(md).toContain("## REOPENED");
    expect(md).toContain("REOPENED: still broken");
    expect(buildTicketContextMarkdown({ title: "x" })).not.toContain("## REOPENED");
  });
});
