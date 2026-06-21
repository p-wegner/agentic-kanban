/**
 * Regression test for #776: moving an issue to a terminal status (Done/Cancelled)
 * must close any still-open workspace for it, so the in-process monitor stops
 * trying to relaunch the now-pointless idle workspace every cycle.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";

let db: TestDb;
let projectId: string;
let inProgressStatusId: string;
let doneStatusId: string;

async function workspaceStatus(workspaceId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return rows[0].status;
}

async function seedIdleWorkspace(issueId: string, isDirect = false): Promise<string> {
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/work",
    workingDir: "/tmp/term-test/.worktrees/work",
    baseBranch: "main",
    status: "idle",
    isDirect,
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

beforeEach(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Terminal Close Test",
    repoPath: "/tmp/term-test",
    repoName: "term-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  inProgressStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: inProgressStatusId,
    projectId,
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  doneStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: doneStatusId,
    projectId,
    name: "Done",
    sortOrder: 2,
    isDefault: false,
    createdAt: now,
  });
});

describe("updateIssue closes open workspaces on terminal transition (#776)", () => {
  it("closes a still-open DIRECT workspace when the issue moves to Done", async () => {
    // Post #854 the close-on-Done path only applies to DIRECT workspaces — a
    // non-direct open workspace now BLOCKS the terminal move (AK-535 guard), so it
    // is never auto-closed. Direct workspaces commit straight to the default branch
    // (no branch to strand), so moving to Done is allowed and still closes them.
    const now = new Date().toISOString();
    const issueService = createIssueService({ database: db });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Feature: ship it",
      statusId: inProgressStatusId,
      projectId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await seedIdleWorkspace(issueId, true);
    expect(await workspaceStatus(workspaceId)).toBe("idle");

    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    expect(await workspaceStatus(workspaceId)).toBe("closed");
  });

  it("does not touch workspaces on a non-terminal status change", async () => {
    const now = new Date().toISOString();
    const issueService = createIssueService({ database: db });

    const backlogStatusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: backlogStatusId,
      projectId,
      name: "Backlog",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Feature: still going",
      statusId: backlogStatusId,
      projectId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await seedIdleWorkspace(issueId);

    await issueService.updateIssue(issueId, { statusId: inProgressStatusId });

    expect(await workspaceStatus(workspaceId)).toBe("idle");
  });

  it("does not reopen/re-close an already-closed (e.g. merged) workspace", async () => {
    const now = new Date().toISOString();
    const issueService = createIssueService({ database: db });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 3,
      title: "Feature: merged",
      statusId: inProgressStatusId,
      projectId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/merged",
      workingDir: null,
      baseBranch: "main",
      status: "closed",
      mergedAt,
      closedAt: mergedAt,
      createdAt: now,
      updatedAt: now,
    });

    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    const rows = await db
      .select({ status: schema.workspaces.status, mergedAt: schema.workspaces.mergedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    expect(rows[0].status).toBe("closed");
    // mergedAt must be preserved (the update skips already-closed workspaces).
    expect(rows[0].mergedAt).toBe(mergedAt);
  });
});
