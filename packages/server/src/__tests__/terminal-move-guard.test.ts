/**
 * Regression tests for #854: the AK-535 silent-merge-loss guard must be enforced on
 * the server transition path (PATCH /api/issues -> issue.service.updateIssue and the
 * bulk path), not only in the MCP tools. Moving an issue to a terminal status
 * (Done/Cancelled) while it has an open, NON-DIRECT, unmerged workspace strands the
 * branch, so the move is blocked. Direct workspaces (commit to the default branch,
 * no branch to strand) are allowed. The shared seam is
 * workspace.repository.findOpenUnmergedWorkspace.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";
import { findOpenUnmergedWorkspace } from "../repositories/workspace.repository.js";

let db: TestDb;
let projectId: string;
let inProgressStatusId: string;
let doneStatusId: string;

async function statusOf(workspaceId: string): Promise<string> {
  const rows = await db.select({ status: schema.workspaces.status }).from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return rows[0].status;
}

async function statusIdOf(issueId: string): Promise<string> {
  const rows = await db.select({ statusId: schema.issues.statusId }).from(schema.issues)
    .where(eq(schema.issues.id, issueId)).limit(1);
  return rows[0].statusId;
}

async function seedIssue(issueNumber: number): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id, issueNumber, title: `Issue ${issueNumber}`, statusId: inProgressStatusId, projectId,
    skipAutoReview: true, createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedWorkspace(issueId: string, opts: { status?: string; isDirect?: boolean } = {}): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.workspaces).values({
    id, issueId, branch: "feature/ak-x", workingDir: "/tmp/g/.worktrees/x", baseBranch: "main",
    status: opts.status ?? "idle", isDirect: opts.isDirect ?? false, createdAt: now, updatedAt: now,
  });
  return id;
}

beforeEach(async () => {
  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Guard Test", repoPath: "/tmp/g", repoName: "g", defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  inProgressStatusId = randomUUID();
  doneStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
});

describe("findOpenUnmergedWorkspace (#854 shared seam)", () => {
  it("returns an open, non-direct workspace; null for closed / direct / none", async () => {
    const issueId = await seedIssue(1);
    expect(await findOpenUnmergedWorkspace(issueId, db)).toBeNull();

    const wsId = await seedWorkspace(issueId, { status: "idle", isDirect: false });
    const found = await findOpenUnmergedWorkspace(issueId, db);
    expect(found?.id).toBe(wsId);
    expect(found?.branch).toBe("feature/ak-x");

    // Closed (e.g. merged) is not blocking.
    await db.update(schema.workspaces).set({ status: "closed" }).where(eq(schema.workspaces.id, wsId));
    expect(await findOpenUnmergedWorkspace(issueId, db)).toBeNull();

    // Direct workspace (commits to default branch) is excluded even when open.
    const directIssue = await seedIssue(2);
    await seedWorkspace(directIssue, { status: "active", isDirect: true });
    expect(await findOpenUnmergedWorkspace(directIssue, db)).toBeNull();
  });
});

describe("updateIssue terminal-move guard (#854)", () => {
  it("BLOCKS a move to Done while a non-direct workspace is open + unmerged (no status change, no auto-close)", async () => {
    const issueService = createIssueService({ database: db });
    const issueId = await seedIssue(1);
    const wsId = await seedWorkspace(issueId, { status: "idle", isDirect: false });

    await expect(issueService.updateIssue(issueId, { statusId: doneStatusId }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    // The block is a no-op: status unchanged AND the workspace is NOT auto-closed.
    expect(await statusIdOf(issueId)).toBe(inProgressStatusId);
    expect(await statusOf(wsId)).toBe("idle");
  });

  it("ALLOWS a move to Done with an open DIRECT workspace (and closes it per #776)", async () => {
    const issueService = createIssueService({ database: db });
    const issueId = await seedIssue(1);
    const wsId = await seedWorkspace(issueId, { status: "idle", isDirect: true });

    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    expect(await statusIdOf(issueId)).toBe(doneStatusId);
    expect(await statusOf(wsId)).toBe("closed");
  });

  it("ALLOWS a move to Done when the workspace is already closed/merged", async () => {
    const issueService = createIssueService({ database: db });
    const issueId = await seedIssue(1);
    await seedWorkspace(issueId, { status: "closed", isDirect: false });

    await issueService.updateIssue(issueId, { statusId: doneStatusId });
    expect(await statusIdOf(issueId)).toBe(doneStatusId);
  });

  it("ALLOWS a move to Done when there is no workspace", async () => {
    const issueService = createIssueService({ database: db });
    const issueId = await seedIssue(1);
    await issueService.updateIssue(issueId, { statusId: doneStatusId });
    expect(await statusIdOf(issueId)).toBe(doneStatusId);
  });

  it("ALLOWS a non-terminal move with an open non-direct workspace", async () => {
    const issueService = createIssueService({ database: db });
    const issueId = await seedIssue(1);
    // Start in Done... no — start in a non-terminal and move to another non-terminal.
    const backlogStatusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: backlogStatusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: new Date().toISOString(),
    });
    await db.update(schema.issues).set({ statusId: backlogStatusId }).where(eq(schema.issues.id, issueId));
    const wsId = await seedWorkspace(issueId, { status: "active", isDirect: false });

    await issueService.updateIssue(issueId, { statusId: inProgressStatusId });
    expect(await statusIdOf(issueId)).toBe(inProgressStatusId);
    expect(await statusOf(wsId)).toBe("active"); // untouched
  });
});

describe("updateIssuesBulk terminal-move guard (#854)", () => {
  it("BLOCKS the whole batch when any issue has an open non-direct workspace", async () => {
    const issueService = createIssueService({ database: db });
    const clean = await seedIssue(1);
    const blocked = await seedIssue(2);
    await seedWorkspace(blocked, { status: "idle", isDirect: false });

    await expect(issueService.updateIssuesBulk([clean, blocked], { statusId: doneStatusId }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    // Atomic: neither issue moved.
    expect(await statusIdOf(clean)).toBe(inProgressStatusId);
    expect(await statusIdOf(blocked)).toBe(inProgressStatusId);
  });

  it("ALLOWS a bulk move to Done when no issue has an open non-direct workspace", async () => {
    const issueService = createIssueService({ database: db });
    const a = await seedIssue(1);
    const b = await seedIssue(2);
    await seedWorkspace(b, { status: "closed", isDirect: false }); // merged — not blocking

    await issueService.updateIssuesBulk([a, b], { statusId: doneStatusId });
    expect(await statusIdOf(a)).toBe(doneStatusId);
    expect(await statusIdOf(b)).toBe(doneStatusId);
  });
});
