import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, agentSkills, scheduledRunHistory } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createScheduledRunService } from "../services/scheduled-run.service.js";
import { createScheduledRun } from "../repositories/scheduled-run.repository.js";

async function seedProject(db: TestDb): Promise<{ projectId: string; statusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  return { projectId, statusId };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string): Promise<string> {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "⏰ My Scheduled Run",
    description: "System issue",
    priority: "low",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return issueId;
}

describe("createScheduledRunService", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe("run()", () => {
    it("calls createWorkspace directly (no fetch) and stores workspaceId", async () => {
      const { projectId, statusId } = await seedProject(db);
      const systemIssueId = await seedIssue(db, projectId, statusId);

      const mockWorkspace = { id: randomUUID(), issueId: systemIssueId, branch: "direct", workingDir: null, baseBranch: null, isDirect: true, planMode: false, includeVisualProof: false, status: "running", provider: "claude" as const, createdAt: new Date().toISOString() };
      const createWorkspace = vi.fn(async () => mockWorkspace);

      const service = createScheduledRunService({ database: db, createWorkspace });

      // Create the scheduled run record in DB
      const runId = randomUUID();
      await createScheduledRun({
        id: runId,
        name: "My Scheduled Run",
        description: null,
        projectId,
        prompt: "Do something useful",
        skillId: null,
        intervalMinutes: 60,
        cronExpression: null,
        enabled: true,
        systemIssueId,
      }, db);

      const result = await service.run(runId);

      // createWorkspace was called directly — no fetch
      expect(createWorkspace).toHaveBeenCalledOnce();
      expect(createWorkspace).toHaveBeenCalledWith({
        issueId: systemIssueId,
        isDirect: true,
        customPrompt: "Do something useful",
        skipSetup: true,
      });

      expect(result.workspaceId).toBe(mockWorkspace.id);
    });

    it("uses skill prompt when skillId is set", async () => {
      const { projectId, statusId } = await seedProject(db);
      const systemIssueId = await seedIssue(db, projectId, statusId);

      const now = new Date().toISOString();
      const skillId = randomUUID();
      await db.insert(agentSkills).values({
        id: skillId,
        name: "code-review",
        description: "Review code",
        prompt: "Please review the code thoroughly",
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });

      const mockWorkspace = { id: randomUUID(), issueId: systemIssueId, branch: "direct", workingDir: null, baseBranch: null, isDirect: true, planMode: false, includeVisualProof: false, status: "running", provider: "claude" as const, createdAt: now };
      const createWorkspace = vi.fn(async () => mockWorkspace);

      const service = createScheduledRunService({ database: db, createWorkspace });

      const runId = randomUUID();
      await createScheduledRun({
        id: runId,
        name: "My Scheduled Run",
        description: null,
        projectId,
        prompt: null,
        skillId,
        intervalMinutes: 60,
        cronExpression: null,
        enabled: true,
        systemIssueId,
      }, db);

      await service.run(runId);

      expect(createWorkspace).toHaveBeenCalledOnce();
      const call = createWorkspace.mock.calls[0][0];
      expect(call.customPrompt).toBe("/code-review\n\nPlease review the code thoroughly");
    });

    it("throws BAD_REQUEST when no prompt or skill is configured", async () => {
      const { projectId, statusId } = await seedProject(db);
      const systemIssueId = await seedIssue(db, projectId, statusId);

      const createWorkspace = vi.fn();
      const service = createScheduledRunService({ database: db, createWorkspace });

      const runId = randomUUID();
      await createScheduledRun({
        id: runId,
        name: "Empty Run",
        description: null,
        projectId,
        prompt: null,
        skillId: null,
        intervalMinutes: 60,
        cronExpression: null,
        enabled: true,
        systemIssueId,
      }, db);

      await expect(service.run(runId)).rejects.toThrow("No prompt or skill configured");
      expect(createWorkspace).not.toHaveBeenCalled();
    });

    it("records failed launch history rows with a visible reason", async () => {
      const { projectId, statusId } = await seedProject(db);
      const systemIssueId = await seedIssue(db, projectId, statusId);

      const createWorkspace = vi.fn();
      const service = createScheduledRunService({ database: db, createWorkspace });

      const runId = randomUUID();
      await createScheduledRun({
        id: runId,
        name: "Empty Run",
        description: null,
        projectId,
        prompt: null,
        skillId: null,
        intervalMinutes: 60,
        cronExpression: null,
        enabled: true,
        systemIssueId,
      }, db);

      await expect(service.run(runId, "scheduler")).rejects.toThrow("No prompt or skill configured");

      const rows = await db.select().from(scheduledRunHistory);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scheduledRunId: runId,
        projectId,
        status: "error",
        reason: "No prompt or skill configured for this scheduled run",
        triggeredBy: "scheduler",
        issueId: systemIssueId,
        workspaceId: null,
      });

      const [listed] = await service.list(projectId);
      expect(listed.latestHistory?.reason).toBe("No prompt or skill configured for this scheduled run");
      expect(listed.history).toHaveLength(1);
    });
  });
});
