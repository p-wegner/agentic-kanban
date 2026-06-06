import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { issues, projects, projectStatuses, sessions, workflowEdges, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const getDiffShortstat = vi.fn();
const getLatestCommit = vi.fn();
const getCommitCountAhead = vi.fn();
const detectConflicts = vi.fn();
const computeWorkspaceCodeMetrics = vi.fn();

vi.mock("../services/git.service.js", () => ({
  getDiffShortstat: (...args: unknown[]) => getDiffShortstat(...args),
  getLatestCommit: (...args: unknown[]) => getLatestCommit(...args),
  getCommitCountAhead: (...args: unknown[]) => getCommitCountAhead(...args),
  detectConflicts: (...args: unknown[]) => detectConflicts(...args),
}));

vi.mock("../services/workspace-code-metrics.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-code-metrics.service.js")>();
  return {
    ...actual,
    computeWorkspaceCodeMetrics: (...args: unknown[]) => computeWorkspaceCodeMetrics(...args),
  };
});

import { buildWorkspaceSummaryMap } from "../services/workspace-summary.service.js";

describe("workspace-summary.service", () => {
  beforeEach(() => {
    getDiffShortstat.mockReset();
    getLatestCommit.mockReset().mockResolvedValue(null);
    getCommitCountAhead.mockReset().mockResolvedValue(0);
    detectConflicts.mockReset().mockResolvedValue({ hasConflicts: false, conflictingFiles: [] });
    computeWorkspaceCodeMetrics.mockReset().mockResolvedValue(null);
  });

  it("includes stored code metrics in the board workspace summary", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const metrics = {
      computedAt: now,
      coverage: { linesPct: 84.5, covered: 169, total: 200, source: "coverage/coverage-summary.json" },
      lint: { errors: 1, warnings: 2, violations: 3, source: "eslint-report.json" },
      complexity: { average: 6.2, max: 14, files: 9, source: "heuristic" as const },
    };

    await db.insert(projects).values({
      id: projectId,
      name: "Metrics Project",
      repoPath: "/tmp/metrics-project",
      repoName: "metrics-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "Done",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Show metrics",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/metrics",
      status: "idle",
      codeMetricsJson: JSON.stringify(metrics),
      codeMetricsComputedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    expect(summaryMap.get(issueId)?.main?.codeMetrics).toEqual(metrics);
  });

  it("includes workflow progress for the main workspace", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Workflow Project",
      repoPath: "/tmp/workflow-project",
      repoName: "workflow-project",
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
    await db.insert(workflowTemplates).values({
      id: templateId,
      projectId,
      name: "Feature workflow",
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
    ]);
    await db.insert(workflowEdges).values({
      id: randomUUID(),
      templateId,
      fromNodeId: implementNodeId,
      toNodeId: reviewNodeId,
      condition: "manual",
      sortOrder: 0,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Show workflow",
      statusId,
      projectId,
      workflowTemplateId: templateId,
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/workflow",
      status: "idle",
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    expect(summaryMap.get(issueId)?.main?.workflow).toEqual({
      currentNodeId: implementNodeId,
      currentNodeName: "Implement",
      currentNodeType: "normal",
      currentNodeStatusName: "In Progress",
      state: "waiting",
      nextStages: ["Review"],
    });
  });

  it("prefers stored contextTokens over cumulative input token totals", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Context Project",
      repoPath: "/tmp/context-project",
      repoName: "context-project",
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
      issueNumber: 3,
      title: "Show context",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/context",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "codex",
      status: "completed",
      startedAt: now,
      endedAt: now,
      stats: JSON.stringify({ inputTokens: 300_000, outputTokens: 1_000, contextTokens: 42_000 }),
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    expect(summaryMap.get(issueId)?.main?.contextTokens).toBe(42_000);
  });

  it("issues a bounded number of DB queries independent of issue count", async () => {
    // Verifies the N+1 fix: DB round-trips must not grow linearly with issueCount.
    // We seed N issues each with a workspace, count the execute() calls for N=2 vs
    // N=6, and assert the delta is zero (all queries use IN-clauses over all IDs).
    async function countQueriesForIssues(n: number): Promise<number> {
      const { client, db } = createTestDb();
      const now = new Date().toISOString();
      const projectId = randomUUID();
      const statusId = randomUUID();

      await db.insert(projects).values({
        id: projectId,
        name: "Batch Project",
        repoPath: "/tmp/batch-project",
        repoName: "batch-project",
        defaultBranch: "main",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(projectStatuses).values({
        id: statusId,
        projectId,
        name: "Todo",
        sortOrder: 0,
        isDefault: true,
        createdAt: now,
      });

      const issueIds: string[] = [];
      for (let i = 0; i < n; i++) {
        const issueId = randomUUID();
        issueIds.push(issueId);
        await db.insert(issues).values({
          id: issueId,
          issueNumber: i + 1,
          title: `Issue ${i}`,
          statusId,
          projectId,
          createdAt: now,
          updatedAt: now,
        });
        await db.insert(workspaces).values({
          id: randomUUID(),
          issueId,
          branch: `feature/issue-${i}`,
          // closed so no git operations are triggered
          status: "closed",
          createdAt: now,
          updatedAt: now,
        });
      }

      let queryCount = 0;
      const originalExecute = client.execute.bind(client);
      const spy = vi.spyOn(client, "execute").mockImplementation((...args) => {
        queryCount++;
        return originalExecute(...args);
      });

      await buildWorkspaceSummaryMap(issueIds, "main", db);

      spy.mockRestore();
      return queryCount;
    }

    const queriesFor2 = await countQueriesForIssues(2);
    const queriesFor6 = await countQueriesForIssues(6);

    // Query count must be identical — all queries use IN clauses over all issue IDs.
    expect(queriesFor6).toBe(queriesFor2);
  });

  it("serves cached diff stats without triggering a refresh when HEAD SHA is unchanged", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const recentCheckedAt = new Date(Date.now() - 5_000).toISOString(); // 5s ago — within TTL
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const headSha = "abc123def456";

    getLatestCommit.mockResolvedValue({ sha: headSha, message: "latest commit" });

    await db.insert(projects).values({
      id: projectId,
      name: "Cache Project",
      repoPath: "/tmp/cache-project",
      repoName: "cache-project",
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
      issueNumber: 10,
      title: "Cached diff issue",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/cached",
      workingDir: "/tmp/cache-project/.worktrees/cached",
      baseBranch: "main",
      status: "idle",
      // Cache is fresh and HEAD SHA matches
      diffStatCacheCheckedAt: recentCheckedAt,
      diffStatCacheHeadSha: headSha,
      diffStatCacheFilesChanged: 3,
      diffStatCacheInsertions: 42,
      diffStatCacheDeletions: 7,
      createdAt: now,
      updatedAt: now,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    const main = summaryMap.get(issueId)?.main;
    expect(main?.diffStats).toEqual({ filesChanged: 3, insertions: 42, deletions: 7 });
    expect(getDiffShortstat).not.toHaveBeenCalled();
  });

  it("triggers background diff refresh immediately when HEAD SHA advances", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const recentCheckedAt = new Date(Date.now() - 5_000).toISOString(); // 5s ago — within TTL
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const oldHeadSha = "old111sha";
    const newHeadSha = "new222sha";

    getLatestCommit.mockResolvedValue({ sha: newHeadSha, message: "new commit" });
    getDiffShortstat.mockResolvedValue({ filesChanged: 5, insertions: 100, deletions: 20 });

    await db.insert(projects).values({
      id: projectId,
      name: "Head Changed Project",
      repoPath: "/tmp/head-changed",
      repoName: "head-changed",
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
      issueNumber: 11,
      title: "HEAD changed issue",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/head-changed",
      workingDir: "/tmp/head-changed/.worktrees/head-changed",
      baseBranch: "main",
      status: "idle",
      // Cache is within TTL but HEAD SHA is outdated
      diffStatCacheCheckedAt: recentCheckedAt,
      diffStatCacheHeadSha: oldHeadSha,
      diffStatCacheFilesChanged: 3,
      diffStatCacheInsertions: 42,
      diffStatCacheDeletions: 7,
      createdAt: now,
      updatedAt: now,
    });

    await buildWorkspaceSummaryMap([issueId], "main", db);

    // Background refresh must be triggered because HEAD advanced
    await vi.waitFor(() => expect(getDiffShortstat).toHaveBeenCalledWith(
      "/tmp/head-changed/.worktrees/head-changed",
      "main",
    ));
  });

  it("omits closed workspaces from main for non-archived issues (backlog/todo)", async () => {
    // Regression test for #663: a backlog issue with only closed workspaces
    // should have workspaceSummary.main = null, not point at the closed workspace.
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const backlogStatusId = randomUUID();
    const issueId = randomUUID();
    const closedWorkspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Closed WS Project",
      repoPath: "/tmp/closed-ws-project",
      repoName: "closed-ws-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: backlogStatusId,
      projectId,
      name: "Backlog",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 20,
      title: "Closed workspace on backlog",
      statusId: backlogStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: closedWorkspaceId,
      issueId,
      branch: "feature/closed-then-reset",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    });

    // No archivedIssueIds — issue is in Backlog, not Done/Cancelled
    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    const summary = summaryMap.get(issueId);
    expect(summary).toBeDefined();
    // total/closed counts should still reflect the closed workspace
    expect(summary!.total).toBe(1);
    expect(summary!.closed).toBe(1);
    // But main should NOT point at the closed workspace for a backlog issue
    expect(summary!.main).toBeUndefined();
  });

  it("keeps closed workspace as main for archived issues (Done/Cancelled)", async () => {
    // Archived issues should still show their closed/merged workspace as main.
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const closedWorkspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Archived Project",
      repoPath: "/tmp/archived-project",
      repoName: "archived-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: doneStatusId,
      projectId,
      name: "Done",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 21,
      title: "Done issue with closed workspace",
      statusId: doneStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: closedWorkspaceId,
      issueId,
      branch: "feature/done-feature",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    });

    // Issue is archived (Done)
    const archivedIssueIds = new Set([issueId]);
    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db, archivedIssueIds);

    const summary = summaryMap.get(issueId);
    expect(summary).toBeDefined();
    expect(summary!.main).not.toBeNull();
    expect(summary!.main!.status).toBe("closed");
  });

  it("prefers active workspace over closed for backlog issues", async () => {
    // A backlog issue with both active and closed workspaces should pick the active one.
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const backlogStatusId = randomUUID();
    const issueId = randomUUID();
    const closedWorkspaceId = randomUUID();
    const activeWorkspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Mixed WS Project",
      repoPath: "/tmp/mixed-ws-project",
      repoName: "mixed-ws-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: backlogStatusId,
      projectId,
      name: "Backlog",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 22,
      title: "Backlog with active and closed workspaces",
      statusId: backlogStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values([
      {
        id: closedWorkspaceId,
        issueId,
        branch: "feature/old-attempt",
        status: "closed",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: activeWorkspaceId,
        issueId,
        branch: "feature/new-attempt",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    const summary = summaryMap.get(issueId);
    expect(summary).toBeDefined();
    expect(summary!.main).not.toBeNull();
    expect(summary!.main!.id).toBe(activeWorkspaceId);
    expect(summary!.main!.status).toBe("active");
  });
});
