// #1206 — findStrandedInReviewIssueIds: a pure-DB predicate for "issue In Review +
// no open workspace + branch exists with unmerged commits". Shared by
// board-risk-digest.service.ts's stranded_in_review category; the MCP
// list_issues strandedInReview filter mirrors the same predicate (mcp-server
// cannot import server code) and should be kept in sync with this test's cases.

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { findStrandedInReviewIssueIds } from "../services/stranded-in-review.service.js";

async function seedIssue(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "p", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, createdAt: now });
  await db.insert(issues).values({
    id: issueId, projectId, statusId, title: "t", issueNumber: Math.floor(Math.random() * 1_000_000),
    createdAt: now, updatedAt: now,
  });
  return issueId;
}

async function seedWorkspace(db: TestDb, issueId: string, opts: {
  status?: string;
  isDirect?: boolean;
  mergedAt?: string | null;
  updatedAt?: string;
} = {}) {
  const now = opts.updatedAt ?? new Date().toISOString();
  await db.insert(workspaces).values({
    id: randomUUID(), issueId, branch: `feature/${randomUUID().slice(0, 8)}`, baseBranch: "main",
    isDirect: opts.isDirect ?? false,
    status: opts.status ?? "closed",
    mergedAt: opts.mergedAt ?? null,
    updatedAt: now,
  });
}

describe("findStrandedInReviewIssueIds (#1206)", () => {
  it("flags an issue whose only workspace is closed and unmerged", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId);

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([issueId]);
  });

  it("does not flag an issue with an open workspace", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, { status: "idle" });

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([]);
  });

  it("does not flag an issue whose latest closed workspace is merged", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, { mergedAt: new Date().toISOString() });

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([]);
  });

  it("does not flag a direct workspace", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, { isDirect: true });

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([]);
  });

  it("does not flag an issue with no workspace at all", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([]);
  });

  it("does not flag when ANY workspace for the issue is open, even if an older one is closed", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, { status: "closed", updatedAt: "2020-01-01T00:00:00.000Z" });
    await seedWorkspace(db, issueId, { status: "idle", updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([]);
  });

  it("flags based on the LATEST closed workspace when several are closed", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    // Older workspace was merged; the newer one is closed-unmerged (the stranded one).
    await seedWorkspace(db, issueId, { mergedAt: "2020-01-02T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
    await seedWorkspace(db, issueId, { updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(await findStrandedInReviewIssueIds([issueId], db)).toEqual([issueId]);
  });

  it("returns [] for an empty input", async () => {
    const { db } = createTestDb();
    expect(await findStrandedInReviewIssueIds([], db)).toEqual([]);
  });
});
