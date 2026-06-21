/**
 * Regression tests for #591: GET /board cache still serves stale column after
 * PATCH /api/issues/:id changes statusId.
 *
 * Scenarios covered:
 * 1. Simple PATCH status change (no workspace) — board reflects new column.
 * 2. PATCH with an idle workspace that has a workflow currentNodeId — board shows
 *    the new column, not the node's old statusName (verifies syncCurrentNodeToStatus).
 * 3. Stale-while-revalidate race — a PATCH that fires during a background rebuild
 *    must not be overwritten by the completing rebuild.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";
import { createIssueService } from "../services/issue.service.js";
import { createBoardEvents } from "../services/board-events.js";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";

let db: TestDb;
let projectId: string;
let inReviewStatusId: string;
let doneStatusId: string;

beforeEach(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Cache Invalidation Test",
    repoPath: "/tmp/cache-test",
    repoName: "cache-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  inReviewStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: inReviewStatusId,
    projectId,
    name: "In Review",
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

describe("board cache invalidation on PATCH issue statusId", () => {
  it("reflects new column after PATCH with no workspace (simple case)", async () => {
    const now = new Date().toISOString();
    const boardEvents = createBoardEvents();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    boardEvents.addInvalidationListener((pid) => workspaceSummaryCache.invalidate(pid));

    const issueService = createIssueService({ database: db, boardEvents });
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Chore: update docs",
      statusId: inReviewStatusId,
      projectId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    // Warm the cache via getBoard.
    let board = await projectService.getBoard(projectId, now);
    let inReviewCol = board.find((c) => c.name === "In Review");
    expect(inReviewCol?.issues.some((i) => i.id === issueId)).toBe(true);

    // PATCH status to Done.
    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    // Board must reflect the new column immediately (cache was invalidated by the broadcast).
    board = await projectService.getBoard(projectId, now);
    inReviewCol = board.find((c) => c.name === "In Review");
    const doneCol = board.find((c) => c.name === "Done");

    expect(inReviewCol?.issues.some((i) => i.id === issueId)).toBe(false);
    expect(doneCol?.issues.some((i) => i.id === issueId)).toBe(true);
  });

  it("reflects new column after PATCH when issue has an idle workspace with a workflow node", async () => {
    const now = new Date().toISOString();
    const boardEvents = createBoardEvents();
    const workspaceSummaryCache = createWorkspaceSummaryCache();
    boardEvents.addInvalidationListener((pid) => workspaceSummaryCache.invalidate(pid));

    const issueService = createIssueService({ database: db, boardEvents });
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    // Set up a workflow template with two nodes: "In Review" and "Done".
    const templateId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId,
      name: "Simple",
      createdAt: now,
      updatedAt: now,
    });

    const inReviewNodeId = randomUUID();
    await db.insert(schema.workflowNodes).values({
      id: inReviewNodeId,
      templateId,
      name: "Review",
      nodeType: "normal",
      statusName: "In Review",
      sortOrder: 1,
      createdAt: now,
    });

    const doneNodeId = randomUUID();
    await db.insert(schema.workflowNodes).values({
      id: doneNodeId,
      templateId,
      name: "Done",
      nodeType: "end",
      statusName: "Done",
      sortOrder: 2,
      createdAt: now,
    });

    // Issue is currently "In Review" and uses the workflow template.
    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Chore: fix CI",
      statusId: inReviewStatusId,
      projectId,
      workflowTemplateId: templateId,
      currentNodeId: inReviewNodeId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    // Idle workspace whose currentNodeId points to the "In Review" workflow node.
    // isDirect so the move to Done is not blocked by the AK-535 terminal-move guard
    // (#854) — direct workspaces commit to the default branch, no branch to strand —
    // while still exercising the workspace currentNode sync this test covers.
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ci-fix",
      workingDir: "/tmp/cache-test/.worktrees/ci-fix",
      baseBranch: "main",
      status: "idle",
      isDirect: true,
      currentNodeId: inReviewNodeId,
      createdAt: now,
      updatedAt: now,
    });

    // Warm the cache.
    let board = await projectService.getBoard(projectId, now);
    let inReviewCol = board.find((c) => c.name === "In Review");
    expect(inReviewCol?.issues.some((i) => i.id === issueId)).toBe(true);

    // PATCH status to Done. syncCurrentNodeToStatus should update the workspace's
    // currentNodeId to the Done node so the board no longer shows "In Review".
    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    board = await projectService.getBoard(projectId, now);
    inReviewCol = board.find((c) => c.name === "In Review");
    const doneCol = board.find((c) => c.name === "Done");

    expect(inReviewCol?.issues.some((i) => i.id === issueId)).toBe(false);
    expect(doneCol?.issues.some((i) => i.id === issueId)).toBe(true);
  });

  it("does not overwrite invalidated cache with stale data from a background rebuild (race condition)", async () => {
    const now = new Date().toISOString();
    const boardEvents = createBoardEvents();
    // Very short TTL so the cache becomes stale quickly; long staleTtl keeps it serveable.
    const workspaceSummaryCache = createWorkspaceSummaryCache({ ttlMs: 1, staleTtlMs: 10_000 });
    boardEvents.addInvalidationListener((pid) => workspaceSummaryCache.invalidate(pid));

    const issueService = createIssueService({ database: db, boardEvents });
    const projectService = createProjectService({ database: db, workspaceSummaryCache });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 3,
      title: "Chore: cleanup",
      statusId: inReviewStatusId,
      projectId,
      skipAutoReview: true,
      createdAt: now,
      updatedAt: now,
    });

    // Warm the cache.
    await projectService.getBoard(projectId, now);

    // Wait for the TTL to expire so the next GET triggers stale-while-revalidate.
    await new Promise((r) => setTimeout(r, 10));

    // This GET will: (a) return stale data, (b) start a background rebuild.
    // The rebuild is async; we intercept to simulate a PATCH arriving during rebuild.
    let resolveRebuild!: () => void;
    const rebuildGate = new Promise<void>((res) => { resolveRebuild = res; });

    // Patch the projectService to intercept the background rebuild result.
    // We simulate a race by: issuing the stale GET, then patching status, then
    // allowing the rebuild to complete.
    // Since the actual background rebuild is fire-and-forget within getBoard(),
    // we need to test the outcome after both complete.
    //
    // Strategy: call getBoard() (returns stale, kicks background rebuild),
    // then PATCH immediately, then wait for the background rebuild to settle
    // (a short delay is enough since the rebuild is Promise-based and awaits DB).
    const staleBoardPromise = projectService.getBoard(projectId, now);
    const staleBoard = await staleBoardPromise;
    // Stale board should still show "In Review" (we just served the old cached value).
    const staleInReview = staleBoard.find((c) => c.name === "In Review");
    expect(staleInReview?.issues.some((i) => i.id === issueId)).toBe(true);

    // PATCH status to Done while the background rebuild is in-flight.
    // This should invalidate the cache, so the rebuild's result is discarded.
    await issueService.updateIssue(issueId, { statusId: doneStatusId });

    // Wait for any in-flight background rebuild to finish.
    await new Promise((r) => setTimeout(r, 50));

    // Now GET /board — must NOT show the old stale-rebuild data.
    const freshBoard = await projectService.getBoard(projectId, now);
    const freshInReview = freshBoard.find((c) => c.name === "In Review");
    const freshDone = freshBoard.find((c) => c.name === "Done");

    expect(freshInReview?.issues.some((i) => i.id === issueId)).toBe(false);
    expect(freshDone?.issues.some((i) => i.id === issueId)).toBe(true);
  });
});
