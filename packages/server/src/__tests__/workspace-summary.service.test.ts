import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";
import { issues, projects, projectStatuses, sessions, workflowEdges, workflowNodes, workflowTemplates, workspaceCodeMetrics, workspaceDiffStatCache, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

// The summary service skips git work for a workingDir that does not EXIST on disk
// (#277 — a set-but-vanished path otherwise costs doomed git spawns on every board
// build). These two suites assert diff-stat caching behaviour, which requires the
// workspace to be eligible, so they need a real directory rather than a made-up path.
const tempWorktrees: string[] = [];
function makeTempWorktree(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ws-summary-${label}-`));
  tempWorktrees.push(dir);
  return dir;
}
// Session .out transcript fixtures (#341) written into %TEMP% under the real
// sessionOutputPath scheme, so the service's bounded reader is exercised for real.
const tempOutFiles: string[] = [];
afterAll(() => {
  while (tempWorktrees.length > 0) {
    try { rmSync(tempWorktrees.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  while (tempOutFiles.length > 0) {
    try { unlinkSync(tempOutFiles.pop()!); } catch { /* best effort */ }
  }
});

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
      createdAt: now,
      updatedAt: now,
    });
    // #798: the metrics artifact lives in `workspace_code_metrics`, not on the workspace row.
    await db.insert(workspaceCodeMetrics).values({
      workspaceId, metricsJson: JSON.stringify(metrics), computedAt: now,
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

  it("G9: latest-session selection is unchanged for a multi-session workspace with the stats-less list query", async () => {
    // The session list query no longer ships every row's stats blob; stats are
    // fetched separately for just the winner. This pins that the winner (and its
    // stats-derived contextTokens) is IDENTICAL to the old single-query semantics.
    const { db } = createTestDb();
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Multi Session", repoPath: "/tmp/multi-session", repoName: "multi-session",
      defaultBranch: "main", createdAt: iso(0), updatedAt: iso(0),
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: iso(0),
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 9, title: "Many sessions", statusId, projectId, createdAt: iso(0), updatedAt: iso(0),
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/many", status: "idle", createdAt: iso(0), updatedAt: iso(0),
    });

    const latestSessionId = randomUUID();
    await db.insert(sessions).values([
      {
        id: randomUUID(), workspaceId, executor: "claude", status: "completed",
        startedAt: iso(3 * 3600_000), endedAt: iso(3 * 3600_000 - 60_000),
        stats: JSON.stringify({ contextTokens: 11_000 }),
      },
      {
        id: latestSessionId, workspaceId, executor: "claude", status: "completed",
        startedAt: iso(1 * 3600_000), endedAt: iso(1 * 3600_000 - 60_000),
        stats: JSON.stringify({ contextTokens: 77_000 }),
      },
      {
        // Noise session (analytics trigger) NEWER than the real latest — must not win.
        id: randomUUID(), workspaceId, executor: "claude", status: "completed",
        startedAt: iso(10 * 60_000), endedAt: iso(9 * 60_000),
        triggerType: "skill:board-monitor",
        stats: JSON.stringify({ contextTokens: 1 }),
      },
      {
        id: randomUUID(), workspaceId, executor: "claude", status: "completed",
        startedAt: iso(2 * 3600_000), endedAt: iso(2 * 3600_000 - 60_000),
        stats: JSON.stringify({ contextTokens: 22_000 }),
      },
    ]);

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);
    const main = summaryMap.get(issueId)?.main;
    expect(main?.lastSessionAt).toBe(iso(1 * 3600_000 - 60_000));
    expect(main?.sessionStatus).toBe("completed");
    expect(main?.contextTokens).toBe(77_000);
    void latestSessionId;
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
      workingDir: makeTempWorktree("cached"),
      baseBranch: "main",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
    // #815: the memo lives in `workspace_diff_stat_cache`. Fresh, and HEAD SHA matches.
    await db.insert(workspaceDiffStatCache).values({
      workspaceId, checkedAt: recentCheckedAt, headSha,
      filesChanged: 3, insertions: 42, deletions: 7,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    const main = summaryMap.get(issueId)?.main;
    expect(main?.diffStats).toEqual({ filesChanged: 3, insertions: 42, deletions: 7 });
    expect(getDiffShortstat).not.toHaveBeenCalled();
  });

  it("triggers background diff refresh immediately when HEAD SHA advances", async () => {
    const headChangedWorktree = makeTempWorktree("head-changed");
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
      workingDir: headChangedWorktree,
      baseBranch: "main",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
    // #815: the memo lives in `workspace_diff_stat_cache`. Within TTL, but HEAD SHA outdated.
    await db.insert(workspaceDiffStatCache).values({
      workspaceId, checkedAt: recentCheckedAt, headSha: oldHeadSha,
      filesChanged: 3, insertions: 42, deletions: 7,
    });

    await buildWorkspaceSummaryMap([issueId], "main", db);

    // Background refresh must be triggered because HEAD advanced
    await vi.waitFor(() => expect(getDiffShortstat).toHaveBeenCalledWith(
      headChangedWorktree,
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

  // #341: the transcript read is BOUNDED to a tail window. Before the fix this was a
  // full readFileSync of a multi-MB .out file on the event loop, and — because the
  // extractors return the FIRST match in whatever window they get — lastTool reported
  // the session's opening tool forever. Both properties are asserted here: the recent
  // (tail) activity is what surfaces, and the >256KB head is never consulted.
  it("derives lastTool/lastAssistantMessage from the tail of a >256KB .out transcript (#341)", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Tail Project",
      repoPath: "/tmp/tail-project",
      repoName: "tail-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Progress",
      sortOrder: 1,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      projectId,
      statusId,
      issueNumber: 1,
      title: "Tail read",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/tail",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "claude",
      status: "running",
      startedAt: now,
    });

    const jsonl = (tool: string, text: string) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: tool }, { type: "text", text }] },
      }) + "\n";

    // The session's OPENING activity, then >256KB of unparseable filler (real
    // transcripts are full of it), then the RECENT activity. The head event is thus
    // outside the tail window: a full-file read reports "Glob" (what this used to do),
    // a bounded tail read reports "Bash".
    const filler = "not-a-json-stream-line padding padding padding\n".repeat(7000);
    expect(filler.length).toBeGreaterThan(256 * 1024);
    const outPath = sessionOutputPath(sessionId);
    writeFileSync(
      outPath,
      jsonl("Glob", "Opening move — must not be reported.")
        + filler
        + jsonl("Bash", "Recent activity — this is the tail."),
      "utf-8",
    );
    tempOutFiles.push(outPath);

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);
    const main = summaryMap.get(issueId)?.main;

    expect(main).toBeTruthy();
    expect(main!.lastTool).toBe("Bash");
    expect(main!.lastAssistantMessage).toBe("Recent activity — this is the tail.");
  });
});
