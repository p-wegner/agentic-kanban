import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projects, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getWorkspaceLaunchFailures } from "../services/workspace-launch-failures.service.js";

function baseProject(projectId: string, now: string) {
  return {
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  };
}

function baseStatus(statusId: string, projectId: string, name: string, now: string) {
  return { id: statusId, projectId, name, sortOrder: 0, isDefault: name === "In Progress", createdAt: now };
}

function baseIssue(issueId: string, projectId: string, statusId: string, now: string, title = "Test Issue") {
  return { id: issueId, issueNumber: 1, title, statusId, projectId, createdAt: now, updatedAt: now };
}

function baseWorkspace(wsId: string, issueId: string, now: string, overrides: Record<string, unknown> = {}) {
  return {
    id: wsId,
    issueId,
    branch: "feature/test",
    workingDir: "/tmp/test/.worktrees/test",
    baseBranch: "main",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseSession(sessionId: string, wsId: string, now: string, overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    workspaceId: wsId,
    executor: "claude-code",
    status: "stopped",
    startedAt: now,
    endedAt: now,
    exitCode: "0",
    ...overrides,
  };
}

describe("getWorkspaceLaunchFailures", () => {
  it("returns empty for project with no workspaces", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(0);
  });

  it("detects zero-output session (<=1s duration)", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    // Session that lasted only 500ms
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 500);

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "1",
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("zero-output");
    expect(result.failures[0].workspaceId).toBe(wsId);
    expect(result.failures[0].issueNumber).toBe(1);
  });

  it("detects zero-output session via zero token counts in stats", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 5000); // 5s but zero tokens

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0, durationMs: 5000 }),
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("zero-output");
  });

  it("detects explicit launchFailure flag in session stats", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 8000);

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      stats: JSON.stringify({ launchFailure: true, failureReason: "Provider auth failed", inputTokens: 0, outputTokens: 0 }),
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("zero-output");
    expect(result.failures[0].lastMessage).toBe("Provider auth failed");
  });

  it("detects setup-failed workspaces", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now, {
      latestSetupState: "failed",
      latestSetupExitCode: 1,
      latestSetupStderrTail: "npm install failed: ENOENT",
      latestSetupEndedAt: now,
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("setup-failed");
    expect(result.failures[0].lastMessage).toContain("npm install failed");
  });

  it("detects missing worktree (workingDir null on non-direct workspace)", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now, { workingDir: null }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("missing-worktree");
  });

  it("detects session-error (non-zero exit code)", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30_000);

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "2",
      stats: JSON.stringify({ inputTokens: 500, outputTokens: 200, durationMs: 30_000 }),
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].failureCategory).toBe("session-error");
  });

  it("excludes closed workspaces", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 500);

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now, { status: "closed" }));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(0);
  });

  it("excludes issues with terminal statuses (Done, Cancelled)", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();

    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(doneStatusId, projectId, "Done", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, doneStatusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now, { workingDir: null }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(0);
  });

  it("does not include successful sessions as failures", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60_000);

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now));
    await db.insert(sessions).values(baseSession(sessionId, wsId, now, {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 1000, outputTokens: 500, durationMs: 60_000, success: true }),
    }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(0);
  });

  it("does not include direct workspaces with null workingDir as missing-worktree", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    await db.insert(issues).values(baseIssue(issueId, projectId, statusId, now));
    // Direct workspace: workingDir is null but that's expected for direct (uses project repoPath)
    await db.insert(workspaces).values(baseWorkspace(wsId, issueId, now, { workingDir: null, isDirect: true }));

    const result = await getWorkspaceLaunchFailures(projectId, db);
    // Direct workspaces don't need their own worktree — should not be flagged
    expect(result.failures.filter(f => f.failureCategory === "missing-worktree")).toHaveLength(0);
  });

  it("returns failures sorted by failedAt descending", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    const wsId1 = randomUUID();
    const wsId2 = randomUUID();

    await db.insert(projects).values(baseProject(projectId, now));
    await db.insert(projectStatuses).values(baseStatus(statusId, projectId, "In Progress", now));
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await db.insert(issues).values([
      baseIssue(issueId1, projectId, statusId, older, "Old Issue"),
      baseIssue(issueId2, projectId, statusId, newer, "New Issue"),
    ]);
    await db.insert(workspaces).values([
      baseWorkspace(wsId1, issueId1, older, { workingDir: null, updatedAt: older }),
      baseWorkspace(wsId2, issueId2, newer, { workingDir: null, updatedAt: newer }),
    ]);

    const result = await getWorkspaceLaunchFailures(projectId, db);
    expect(result.failures).toHaveLength(2);
    // Most recent first
    expect(result.failures[0].failedAt >= result.failures[1].failedAt).toBe(true);
  });
});
