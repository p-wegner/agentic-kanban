import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issues, preferences, projects, projectStatuses, sessionMessages, sessions, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const getDiffShortstat = vi.fn();

vi.mock("../services/git.service.js", () => ({
  getDiffShortstat: (...args: unknown[]) => getDiffShortstat(...args),
  detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
}));

import { getBoardStatus } from "../services/board-status.js";

describe("board-status", () => {
  beforeEach(() => {
    getDiffShortstat.mockReset();
  });

  it("flags zero-diff In Review workspaces that are not ready for merge", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    getDiffShortstat.mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });

    await db.insert(projects).values({
      id: projectId,
      name: "Status Project",
      repoPath: "/tmp/status-project",
      repoName: "status-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Review",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 191,
      title: "Zero diff review",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/zero-diff",
      workingDir: "/tmp/status-project/.worktrees/zero-diff",
      baseBranch: "main",
      status: "active",
      readyForMerge: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: now,
    });
    await db.insert(sessionMessages).values({
      sessionId,
      type: "stdout",
      data: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I am still checking the change set." } }),
      createdAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.issues).toHaveLength(1);
    expect(status.issues[0]).toMatchObject({
      issueNumber: 191,
      title: "Zero diff review",
      statusName: "In Review",
      workspace: { status: "active", readyForMerge: false },
      diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
      lastAgentMessage: "I am still checking the change set.",
      attention: {
        bucket: "needs_attention",
        reason: "idle-awaiting",
      },
    });
  });

  it("keeps idle In Review workspaces with null diff stats visible as needs attention", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Null Diff Project",
      repoPath: "/tmp/null-diff-project",
      repoName: "null-diff-project",
      defaultBranch: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Review",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 197,
      title: "Stale review with missing diff base",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/stale-review",
      workingDir: "/tmp/null-diff-project/.worktrees/stale-review",
      baseBranch: null,
      status: "idle",
      readyForMerge: false,
      createdAt: now,
      updatedAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.issues).toHaveLength(1);
    expect(status.issues[0]).toMatchObject({
      issueNumber: 197,
      title: "Stale review with missing diff base",
      statusName: "In Review",
      workspace: { status: "idle", readyForMerge: false },
      diffStats: null,
      attention: {
        bucket: "needs_attention",
        reason: "stale-in-review",
      },
    });
    expect(getDiffShortstat).not.toHaveBeenCalled();
  });

  it("leaves ready-for-merge In Review workspaces unflagged", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    getDiffShortstat.mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });

    await db.insert(projects).values({
      id: projectId,
      name: "Ready Project",
      repoPath: "/tmp/ready-project",
      repoName: "ready-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Review",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 192,
      title: "Ready review",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ready",
      workingDir: "/tmp/ready-project/.worktrees/ready",
      baseBranch: "main",
      status: "idle",
      readyForMerge: true,
      createdAt: now,
      updatedAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.issues[0]?.workspace?.readyForMerge).toBe(true);
    expect(status.issues[0]?.attention).toBeNull();
  });

  it("classifies idle committed In Review work as pending merge when auto_merge_in_review is enabled", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    getDiffShortstat.mockResolvedValue({ filesChanged: 2, insertions: 12, deletions: 3 });

    await db.insert(projects).values({
      id: projectId,
      name: "Auto Merge Project",
      repoPath: "/tmp/auto-merge-project",
      repoName: "auto-merge-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(preferences).values([
      { key: "auto_merge", value: "true", updatedAt: now },
      { key: "auto_merge_in_review", value: "true", updatedAt: now },
    ]);
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Review",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 245,
      title: "Committed review work",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/committed-review-work",
      workingDir: "/tmp/auto-merge-project/.worktrees/committed-review-work",
      baseBranch: "main",
      status: "idle",
      readyForMerge: false,
      createdAt: now,
      updatedAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.issues[0]).toMatchObject({
      issueNumber: 245,
      statusName: "In Review",
      workspace: { status: "idle", readyForMerge: false },
      diffStats: { filesChanged: 2, insertions: 12, deletions: 3 },
      mergeState: {
        bucket: "pending_merge",
        reason: "auto-merge-in-review",
      },
      attention: null,
    });
  });

  it("reports active workflow Review progress as In Review even if the issue status is stale", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inProgressStatusId = randomUUID();
    const inReviewStatusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Workflow Status Project",
      repoPath: "/tmp/workflow-status-project",
      repoName: "workflow-status-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      {
        id: inProgressStatusId,
        projectId,
        name: "In Progress",
        sortOrder: 0,
        isDefault: true,
        createdAt: now,
      },
      {
        id: inReviewStatusId,
        projectId,
        name: "In Review",
        sortOrder: 1,
        isDefault: false,
        createdAt: now,
      },
    ]);
    await db.insert(workflowTemplates).values({
      id: templateId,
      projectId,
      name: "Implement Review",
      isDefault: false,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowNodes).values([
      {
        id: implementNodeId,
        templateId,
        name: "Implement",
        nodeType: "normal",
        statusName: "In Progress",
        sortOrder: 0,
        createdAt: now,
      },
      {
        id: reviewNodeId,
        templateId,
        name: "Review",
        nodeType: "normal",
        statusName: "In Review",
        sortOrder: 1,
        createdAt: now,
      },
    ] as any);
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 244,
      title: "Workflow status drift",
      statusId: inProgressStatusId,
      projectId,
      workflowTemplateId: templateId,
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/workflow-status-drift",
      status: "idle",
      currentNodeId: reviewNodeId,
      readyForMerge: false,
      createdAt: now,
      updatedAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.issues).toHaveLength(1);
    expect(status.issues[0]).toMatchObject({
      issueNumber: 244,
      statusName: "In Review",
      workspace: { id: workspaceId, status: "idle" },
    });
    expect(status.totals.inProgress).toBe(1);
  });

  it("counts fixing workspaces with running sessions as active capacity", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    getDiffShortstat.mockResolvedValue({ filesChanged: 1, insertions: 2, deletions: 0 });

    await db.insert(projects).values({
      id: projectId,
      name: "Fixing Project",
      repoPath: "/tmp/fixing-project",
      repoName: "fixing-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Progress",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 240,
      title: "Fix merge conflict",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/fixing",
      workingDir: "/tmp/fixing-project/.worktrees/fixing",
      baseBranch: "main",
      status: "fixing",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: now,
    });

    const status = await getBoardStatus({ projectId }, db);

    expect(status.totals).toMatchObject({
      activeWorkspaces: 1,
      runningSessions: 1,
    });
    expect(status.issues[0]).toMatchObject({
      issueNumber: 240,
      workspace: { status: "fixing" },
      session: { status: "running" },
    });
  });
});
