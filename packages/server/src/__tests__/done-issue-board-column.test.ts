/**
 * Regression test for issue #606:
 * A Done issue whose workspace still has a workflow node pointing to "In Review"
 * must appear in the Done column on the board — not be overridden to In Review.
 */

vi.mock("../services/git.service.js", () => ({
  getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
  getLatestCommit: vi.fn(async () => null),
  getCommitCountAhead: vi.fn(async () => 0),
  detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
}));

vi.mock("../services/workspace-code-metrics.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-code-metrics.service.js")>();
  return { ...actual, computeWorkspaceCodeMetrics: vi.fn(async () => null) };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projects, projectStatuses, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";

describe("board column: Done issue with stale In Review workflow node (#606)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("places a Done issue in the Done column even when its workspace workflow node says In Review", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inReviewStatusId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const inReviewNodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
    ]);

    // Issue is canonically Done
    await db.insert(issues).values({
      id: issueId, issueNumber: 606, title: "Done issue with stale workflow node",
      priority: "medium", sortOrder: 0,
      statusId: doneStatusId,
      projectId, createdAt: now, updatedAt: now,
    });

    // Workflow node that says "In Review"
    await db.insert(workflowTemplates).values({
      id: templateId, name: "Default", description: null,
      projectId, isDefault: true, createdAt: now, updatedAt: now,
    });
    await db.insert(workflowNodes).values({
      id: inReviewNodeId, templateId,
      name: "In Review", nodeType: "stage",
      statusName: "In Review",
      sortOrder: 1, createdAt: now,
    });

    // Workspace is idle (not closed) and its currentNodeId still points to the In Review node
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/ak-606-test",
      workingDir: null,       // workingDir is null as described in the bug report
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      currentNodeId: inReviewNodeId,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId);

    const inReviewColumn = board.find((col) => col.name === "In Review");
    const doneColumn = board.find((col) => col.name === "Done");

    // The issue must NOT appear in In Review
    expect(inReviewColumn?.issues.find((i) => i.id === issueId)).toBeUndefined();

    // The issue MUST appear in Done
    expect(doneColumn?.issues.find((i) => i.id === issueId)).toBeDefined();
  });

  it("still applies workflow node status override for non-terminal issues", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inProgressStatusId = randomUUID();
    const inReviewStatusId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const inReviewNodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Test2", repoPath: "/repo2", repoName: "repo2",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
    ]);

    // Issue is In Progress by DB status
    await db.insert(issues).values({
      id: issueId, issueNumber: 607, title: "In Progress issue with In Review workflow node",
      priority: "medium", sortOrder: 0,
      statusId: inProgressStatusId,
      projectId, createdAt: now, updatedAt: now,
    });

    await db.insert(workflowTemplates).values({
      id: templateId, name: "Default", description: null,
      projectId, isDefault: true, createdAt: now, updatedAt: now,
    });
    await db.insert(workflowNodes).values({
      id: inReviewNodeId, templateId,
      name: "In Review", nodeType: "stage",
      statusName: "In Review",
      sortOrder: 1, createdAt: now,
    });

    // Workspace is idle with currentNodeId pointing to In Review
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/ak-607-test",
      workingDir: null,
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      currentNodeId: inReviewNodeId,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId);

    const inProgressColumn = board.find((col) => col.name === "In Progress");
    const inReviewColumn = board.find((col) => col.name === "In Review");

    // The workflow node override should place the issue in In Review (not In Progress)
    expect(inProgressColumn?.issues.find((i) => i.id === issueId)).toBeUndefined();
    expect(inReviewColumn?.issues.find((i) => i.id === issueId)).toBeDefined();
  });
});
