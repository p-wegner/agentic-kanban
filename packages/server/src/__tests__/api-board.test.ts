import { describe, it, expect, beforeAll } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TestDb } from "./helpers/test-db.js";
import {
  createTestApp,
  createTestAppWithBoardEvents,
  createProjectDirectly,
  createStatusDirectly,
} from "./helpers/api-test-helpers.js";

describe("Board API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Board Test Project" });
    todoStatusId = await createStatusDirectly(database, projectId, "Todo", 0);
    doneStatusId = await createStatusDirectly(database, projectId, "Done", 1);

    // Create issues in each status
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task 1", statusId: todoStatusId, projectId }),
    });
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task 2", statusId: doneStatusId, projectId }),
    });
  });

  it("GET /api/projects/:id/board returns statuses with nested issues", async () => {
    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.length).toBe(2);
    expect(body[0].name).toBe("Todo");
    expect(body[0].issues.length).toBe(1);
    expect(body[0].count).toBe(1);
    expect(body[0].issues[0].title).toBe("Task 1");
    expect(body[0].issues[0].statusName).toBe("Todo");
    expect(body[1].name).toBe("Done");
    expect(body[1].issues.length).toBe(1);
    expect(body[1].count).toBe(1);
  });

  it("GET /api/projects/:id/board/summary returns per-column counts with no issue bodies", async () => {
    const res = await app.request(`/api/projects/${projectId}/board/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.length).toBe(2);
    const todo = body.find((col: any) => col.name === "Todo");
    const done = body.find((col: any) => col.name === "Done");
    expect(todo).toBeDefined();
    expect(todo.statusId).toBe(todoStatusId);
    expect(todo.sortOrder).toBe(0);
    expect(todo.count).toBe(1);
    expect(done).toBeDefined();
    expect(done.statusId).toBe(doneStatusId);
    expect(done.sortOrder).toBe(1);
    expect(done.count).toBe(1);
    // No issue bodies — only the four summary fields
    expect(todo.issues).toBeUndefined();
    expect(done.issues).toBeUndefined();
  });

  it("GET /api/projects/:id/board/summary returns zero count for empty statuses", async () => {
    const emptyProjectId = await createProjectDirectly(database, { name: "Empty Board Project" });
    const emptyStatusId = await createStatusDirectly(database, emptyProjectId, "Backlog", 0);
    const res = await app.request(`/api/projects/${emptyProjectId}/board/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].statusId).toBe(emptyStatusId);
    expect(body[0].count).toBe(0);
  });

  it("GET /api/projects/:id/board exposes external tracker fields on issues", async () => {
    const linkProjectId = await createProjectDirectly(database, { name: "Board External Link Project" });
    const linkStatusId = await createStatusDirectly(database, linkProjectId, "Todo", 0);
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Linked task",
        statusId: linkStatusId,
        projectId: linkProjectId,
        externalKey: "GH-9",
        externalUrl: "https://github.com/acme/repo/issues/9",
      }),
    });

    const res = await app.request(`/api/projects/${linkProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const issue = body[0].issues[0];
    expect(issue.externalKey).toBe("GH-9");
    expect(issue.externalUrl).toBe("https://github.com/acme/repo/issues/9");
  });

  it("GET /api/projects/:id/board derives the column from active workflow progress", async () => {
    const workflowProjectId = await createProjectDirectly(database, { name: "Workflow Board Project" });
    const inProgressStatusId = await createStatusDirectly(database, workflowProjectId, "In Progress", 0);
    const inReviewStatusId = await createStatusDirectly(database, workflowProjectId, "In Review", 1);
    const now = new Date().toISOString();
    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();
    await database.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId: workflowProjectId,
      name: "Implement Review",
      isDefault: false,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workflowNodes).values([
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

    const issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      projectId: workflowProjectId,
      statusId: inProgressStatusId,
      issueNumber: 244,
      title: "Workflow status drift",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      workflowTemplateId: templateId,
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/workflow-status-drift",
      status: "idle",
      currentNodeId: reviewNodeId,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/projects/${workflowProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.find((column: any) => column.name === "In Progress")?.issues).toHaveLength(0);
    expect(body.find((column: any) => column.name === "In Review")?.issues[0]).toMatchObject({
      id: issueId,
      statusId: inReviewStatusId,
      statusName: "In Review",
    });
  });

  it("GET /api/projects/:id/board includes latest workspace session status and assistant message", async () => {
    const sessionProjectId = await createProjectDirectly(database, { name: "Board Session Project" });
    const statusId = await createStatusDirectly(database, sessionProjectId, "In Progress", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: sessionProjectId,
      statusId,
      issueNumber: 253,
      title: "Surface session state",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/session-state-summary",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: now,
      triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I found the missing board fields." },
      }),
      createdAt: now,
    });

    const res = await app.request(`/api/projects/${sessionProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((column: any) => column.issues);
    const issue = allIssues.find((item: any) => item.id === issueId);

    expect(issue.workspaceSummary.main).toMatchObject({
      id: workspaceId,
      status: "active",
      sessionStatus: "running",
      lastSessionTriggerType: "initial",
      lastAssistantMessage: "I found the missing board fields.",
    });
  });

  it("GET /api/projects/:id/board includes main workspace workingDir", async () => {
    const workspaceProjectId = await createProjectDirectly(database, {
      name: "Workspace Summary Board Project",
      defaultBranch: null,
    });
    const inProgressStatusId = await createStatusDirectly(database, workspaceProjectId, "In Progress", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const workingDir = "C:/andrena/.worktrees/feature_ak-249-board-working-dir";

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: workspaceProjectId,
      statusId: inProgressStatusId,
      issueNumber: 249,
      title: "Expose workspace workingDir",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-249-board-working-dir",
      workingDir,
      status: "reviewing",
      isDirect: true,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/projects/${workspaceProjectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const issue = body.flatMap((column: any) => column.issues).find((item: any) => item.id === issueId);

    expect(issue.workspaceSummary.main).toMatchObject({
      id: workspaceId,
      branch: "feature/ak-249-board-working-dir",
      status: "reviewing",
      workingDir,
    });
  });

  it("GET /api/projects/:id/board returns 404 for missing project", async () => {
    const res = await app.request(`/api/projects/${randomUUID()}/board`);
    expect(res.status).toBe(404);
  });

  it("GET /api/projects/:id/board tolerates Done issue with null/stale workspace summary data (AK-324)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-324 Null Summary Project" });
    const doneStatusId = await createStatusDirectly(database, p, "Done", 1);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: p,
      statusId: doneStatusId,
      issueNumber: 324,
      title: "Reconciled after dropped merge",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Closed workspace with stale/null conflictCacheFiles — mirrors a dropped-merge reconciliation
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-324-null-summary",
      status: "closed",
      // conflictCacheFiles stored as JSON-encoded null ("null") — the bug scenario
      conflictCacheHasConflicts: false,
      conflictCacheFiles: "null",
      conflictCacheCheckedAt: now,
      // diffStat all zeros/null
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: null,
      diffStatCacheDeletions: null,
      // scorecardScore null
      scorecardScore: null,
      createdAt: now,
      updatedAt: now,
    });

    // Session with stats stored as JSON-encoded null
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "claude",
      status: "stopped",
      startedAt: now,
      endedAt: now,
      stats: "null",
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const allIssues = body.flatMap((column: any) => column.issues);
    const issue = allIssues.find((i: any) => i.id === issueId);
    expect(issue).toBeDefined();
    // workspaceSummary must be present and not crash
    expect(issue.workspaceSummary).toBeDefined();
    expect(issue.workspaceSummary.total).toBe(1);
    // main workspace summary must have safe conflict data (array, not null)
    expect(issue.workspaceSummary.main).toBeDefined();
  });

  it("GET /api/projects/:id/board omits lastAssistantMessage/lastTool for closed workspaces (payload slim)", async () => {
    const p = await createProjectDirectly(database, { name: "Closed Summary Slim Project" });
    await createStatusDirectly(database, p, "In Review", 1);
    const inProgressStatusId = await createStatusDirectly(database, p, "In Progress", 0);
    const doneStatusId = await createStatusDirectly(database, p, "Done", 2);
    const now = new Date().toISOString();

    // Closed (merged) workspace whose session has an assistant message + tool use.
    // Lives on an ARCHIVED (Done) issue: per #663 a closed workspace is dropped from `main`
    // for non-archived issues, but archived issues keep their closed/merged main for display
    // — which is exactly where the message-slimming behavior under test applies.
    const closedIssueId = randomUUID();
    const closedWsId = randomUUID();
    const closedSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: closedIssueId, projectId: p, statusId: doneStatusId, issueNumber: 901,
      title: "Closed work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: closedWsId, issueId: closedIssueId, branch: "feature/closed-slim", status: "closed", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: closedSessionId, workspaceId: closedWsId, executor: "claude", status: "stopped", startedAt: now, endedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: closedSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "This should not ship on the board." }] } }),
      createdAt: now,
    });

    // Archived (Done) issue with an IDLE (non-closed) main workspace — P1: archived
    // issues are slimmed regardless of workspace status (their card is a CompletedCard).
    const doneIssueId = randomUUID();
    const doneWsId = randomUUID();
    const doneSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: doneIssueId, projectId: p, statusId: doneStatusId, issueNumber: 903,
      title: "Archived idle work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: doneWsId, issueId: doneIssueId, branch: "feature/done-idle-slim", status: "idle", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: doneSessionId, workspaceId: doneWsId, executor: "claude", status: "stopped", startedAt: now, endedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: doneSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Archived idle message that must not ship." }] } }),
      createdAt: now,
    });

    // Active workspace (control) — its live assistant message MUST still be surfaced.
    const activeIssueId = randomUUID();
    const activeWsId = randomUUID();
    const activeSessionId = randomUUID();
    await database.insert(schema.issues).values({
      id: activeIssueId, projectId: p, statusId: inProgressStatusId, issueNumber: 902,
      title: "Active work", priority: "medium", issueType: "bug", sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: activeWsId, issueId: activeIssueId, branch: "feature/active-slim", status: "active", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: activeSessionId, workspaceId: activeWsId, executor: "claude", status: "running", startedAt: now, triggerType: "initial",
    });
    await database.insert(schema.sessionMessages).values({
      sessionId: activeSessionId, type: "stdout",
      data: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Live agent message." }] } }),
      createdAt: now,
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((c: any) => c.issues);
    const closed = allIssues.find((i: any) => i.id === closedIssueId);
    const doneIdle = allIssues.find((i: any) => i.id === doneIssueId);
    const active = allIssues.find((i: any) => i.id === activeIssueId);

    // Closed workspace summary is still present (counts/branch/status intact)...
    expect(closed.workspaceSummary.main).toBeDefined();
    expect(closed.workspaceSummary.main.status).toBe("closed");
    // ...but the heavy assistant-message text + lastTool are omitted to slim the payload.
    expect(closed.workspaceSummary.main.lastAssistantMessage ?? null).toBeNull();
    expect(closed.workspaceSummary.main.lastTool ?? null).toBeNull();
    // ...while the merged/closed-badge fields are preserved (must NOT be swept into the gate).
    expect(closed.workspaceSummary.main.sessionStatus).toBe("stopped");
    expect(closed.workspaceSummary.main.lastSessionTriggerType).toBe("initial");
    expect(closed.workspaceSummary.main.lastSessionAt).toBeTruthy();

    // Archived (Done) idle workspace is also slimmed even though it is not "closed".
    expect(doneIdle.workspaceSummary.main).toBeDefined();
    expect(doneIdle.workspaceSummary.main.status).toBe("idle");
    expect(doneIdle.workspaceSummary.main.lastAssistantMessage ?? null).toBeNull();

    // The active workspace still surfaces its live assistant message.
    expect(active.workspaceSummary.main.lastAssistantMessage).toBe("Live agent message.");
  });

  it("GET /api/projects/:id/board flags zero-diff In Review workspace with planOnlyWarning (AK-607)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-607 Zero-Diff In Review Project" });
    const inReviewStatusId = await createStatusDirectly(database, p, "In Review", 1);
    const now = new Date().toISOString();

    // Zero-diff idle workspace in In Review — branch present but no diff committed
    const zeroDiffIssueId = randomUUID();
    const zeroDiffWsId = randomUUID();
    await database.insert(schema.issues).values({
      id: zeroDiffIssueId, projectId: p, statusId: inReviewStatusId, issueNumber: 607,
      title: "Zero diff In Review", priority: "medium", issueType: "bug", sortOrder: 0,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: zeroDiffWsId, issueId: zeroDiffIssueId,
      branch: "feature/ak-607-zero-diff",
      workingDir: "/repo/.worktrees/ak-607-zero-diff",
      baseBranch: "master",
      status: "idle",
      isDirect: false,
      readyForMerge: false,
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 0,
      diffStatCacheInsertions: 0,
      diffStatCacheDeletions: 0,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    // Non-zero diff workspace in In Review — should NOT get planOnlyWarning
    const nonZeroDiffIssueId = randomUUID();
    const nonZeroDiffWsId = randomUUID();
    await database.insert(schema.issues).values({
      id: nonZeroDiffIssueId, projectId: p, statusId: inReviewStatusId, issueNumber: 608,
      title: "Non-zero diff In Review", priority: "medium", issueType: "feature", sortOrder: 1,
      createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: nonZeroDiffWsId, issueId: nonZeroDiffIssueId,
      branch: "feature/ak-607-has-diff",
      status: "idle",
      isDirect: false,
      readyForMerge: false,
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 3,
      diffStatCacheInsertions: 42,
      diffStatCacheDeletions: 5,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });

    const res = await app.request(`/api/projects/${p}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const allIssues = body.flatMap((col: any) => col.issues);

    const zeroDiffIssue = allIssues.find((i: any) => i.id === zeroDiffIssueId);
    expect(zeroDiffIssue).toBeDefined();
    expect(zeroDiffIssue.workspaceSummary).toBeDefined();
    expect(zeroDiffIssue.workspaceSummary.main).toBeDefined();
    // Zero-diff idle workspace in In Review must expose planOnlyWarning so the UI/reconciler
    // can treat it as stale and close it rather than leaving it stranded.
    expect(zeroDiffIssue.workspaceSummary.main.planOnlyWarning).toBe(true);

    const nonZeroDiffIssue = allIssues.find((i: any) => i.id === nonZeroDiffIssueId);
    expect(nonZeroDiffIssue).toBeDefined();
    expect(nonZeroDiffIssue.workspaceSummary).toBeDefined();
    expect(nonZeroDiffIssue.workspaceSummary.main).toBeDefined();
    // Workspace with actual changes must NOT be flagged as plan-only.
    expect(nonZeroDiffIssue.workspaceSummary.main.planOnlyWarning).toBe(false);
  });

  it("GET /api/issues tolerates Done issue with null/stale workspace summary data (AK-324)", async () => {
    const p = await createProjectDirectly(database, { name: "AK-324 Issues Null Summary Project" });
    const doneStatusId = await createStatusDirectly(database, p, "Done", 1);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: p,
      statusId: doneStatusId,
      issueNumber: 324,
      title: "Reconciled issue list check",
      priority: "medium",
      issueType: "bug",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-324-null-summary-list",
      status: "closed",
      conflictCacheHasConflicts: null,
      conflictCacheFiles: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/issues?projectId=${p}&issueNumber=324`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(issueId);
  });
});

describe("Board terminal column cap (AK-569)", () => {
  const { app, db: database } = createTestApp();

  it("caps Done/Cancelled columns to 50 issues and exposes the true count", async () => {
    const projectId = await createProjectDirectly(database, { name: "Board Cap Project" });
    const todoStatusId = await createStatusDirectly(database, projectId, "Todo", 0);
    const doneStatusId = await createStatusDirectly(database, projectId, "Done", 1);
    const cancelledStatusId = await createStatusDirectly(database, projectId, "Cancelled", 2);

    const now = new Date();
    // Insert 60 Done issues and 5 Cancelled issues
    const doneIssues = Array.from({ length: 60 }, (_, idx) => ({
      id: randomUUID(),
      projectId,
      statusId: doneStatusId,
      issueNumber: 1000 + idx,
      title: `Done issue ${idx}`,
      priority: "medium" as const,
      issueType: "feature" as const,
      sortOrder: idx,
      createdAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
      updatedAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
      statusChangedAt: new Date(now.getTime() - (60 - idx) * 60000).toISOString(),
    }));
    for (const issue of doneIssues) {
      await database.insert(schema.issues).values(issue);
    }

    const cancelledIssues = Array.from({ length: 5 }, (_, idx) => ({
      id: randomUUID(),
      projectId,
      statusId: cancelledStatusId,
      issueNumber: 2000 + idx,
      title: `Cancelled issue ${idx}`,
      priority: "medium" as const,
      issueType: "feature" as const,
      sortOrder: idx,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }));
    for (const issue of cancelledIssues) {
      await database.insert(schema.issues).values(issue);
    }

    // Insert 3 active (Todo) issues — should be returned in full
    for (let idx = 0; idx < 3; idx++) {
      await app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Todo issue ${idx}`, statusId: todoStatusId, projectId }),
      });
    }

    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const todoCol = body.find((c: any) => c.name === "Todo");
    const doneCol = body.find((c: any) => c.name === "Done");
    const cancelledCol = body.find((c: any) => c.name === "Cancelled");

    // Active column: all issues returned, count matches
    expect(todoCol.issues.length).toBe(3);
    expect(todoCol.count).toBe(3);

    // Terminal Done column: capped at 50, count = true total (60)
    expect(doneCol.count).toBe(60);
    expect(doneCol.issues.length).toBe(50);

    // Issues are ordered by statusChangedAt desc (most recent first)
    const firstTs = new Date(doneCol.issues[0].statusChangedAt ?? doneCol.issues[0].updatedAt).getTime();
    const lastTs = new Date(doneCol.issues[49].statusChangedAt ?? doneCol.issues[49].updatedAt).getTime();
    expect(firstTs).toBeGreaterThanOrEqual(lastTs);

    // Terminal Cancelled column: under cap, count = issues.length
    expect(cancelledCol.count).toBe(5);
    expect(cancelledCol.issues.length).toBe(5);
  });

  it("non-terminal columns (Backlog/In Progress/In Review/AI Reviewed) are never capped", async () => {
    // Regression for #570: capping must only apply to terminal columns.
    // Seed 60 issues in every standard non-terminal column name and assert none are capped.
    const projectId = await createProjectDirectly(database, { name: "Non-Terminal Cap Project" });
    const now = new Date();

    const nonTerminalNames = ["Backlog", "In Progress", "In Review", "AI Reviewed"];
    const statusIds: Record<string, string> = {};
    for (let i = 0; i < nonTerminalNames.length; i++) {
      statusIds[nonTerminalNames[i]] = await createStatusDirectly(database, projectId, nonTerminalNames[i], i);
    }

    const OVER_CAP = 60;
    let issueCounter = 5000;
    for (const [name, statusId] of Object.entries(statusIds)) {
      const issues = Array.from({ length: OVER_CAP }, (_, idx) => ({
        id: randomUUID(),
        projectId,
        statusId,
        issueNumber: issueCounter++,
        title: `${name} issue ${idx}`,
        priority: "medium" as const,
        issueType: "feature" as const,
        sortOrder: idx,
        createdAt: new Date(now.getTime() - idx * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - idx * 1000).toISOString(),
      }));
      for (const issue of issues) {
        await database.insert(schema.issues).values(issue);
      }
    }

    const res = await app.request(`/api/projects/${projectId}/board`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    for (const name of nonTerminalNames) {
      const col = body.find((c: any) => c.name === name);
      expect(col, `column "${name}" should be present`).toBeDefined();
      // Non-terminal columns must never be capped: issues.length === count === OVER_CAP
      expect(col.issues.length).toBe(OVER_CAP);
      expect(col.count).toBe(OVER_CAP);
    }
  });
});

describe("Board archived-issue filtering (AK-457)", () => {
  const { app, db: database } = createTestApp();

  it("omits Archived issues from default board response and includes them with ?includeArchived=true", async () => {
    const pid = await createProjectDirectly(database, { name: "Archived Filter Project" });
    const doneStatusId = await createStatusDirectly(database, pid, "Done", 1);
    const archivedStatusId = await createStatusDirectly(database, pid, "Archived", 99);

    const now = new Date().toISOString();

    const doneIssueId = randomUUID();
    await database.insert(schema.issues).values({
      id: doneIssueId,
      projectId: pid,
      statusId: doneStatusId,
      issueNumber: 4571,
      title: "Done issue",
      priority: "medium",
      issueType: "feature",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    const archivedIssueId = randomUUID();
    await database.insert(schema.issues).values({
      id: archivedIssueId,
      projectId: pid,
      statusId: archivedStatusId,
      issueNumber: 4572,
      title: "Archived issue",
      priority: "medium",
      issueType: "feature",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Default board: Archived column and its issues must be absent
    const defaultRes = await app.request(`/api/projects/${pid}/board`);
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.json() as any[];
    const defaultAllIssues = defaultBody.flatMap((col: any) => col.issues);
    const defaultColumnNames = defaultBody.map((col: any) => col.name);

    expect(defaultColumnNames).not.toContain("Archived");
    expect(defaultAllIssues.map((i: any) => i.id)).not.toContain(archivedIssueId);
    expect(defaultAllIssues.map((i: any) => i.id)).toContain(doneIssueId);

    // includeArchived=true: Archived column and its issues must be present
    const includedRes = await app.request(`/api/projects/${pid}/board?includeArchived=true`);
    expect(includedRes.status).toBe(200);
    const includedBody = await includedRes.json() as any[];
    const includedAllIssues = includedBody.flatMap((col: any) => col.issues);
    const includedColumnNames = includedBody.map((col: any) => col.name);

    expect(includedColumnNames).toContain("Archived");
    expect(includedAllIssues.map((i: any) => i.id)).toContain(archivedIssueId);
    expect(includedAllIssues.map((i: any) => i.id)).toContain(doneIssueId);
  });
});

describe("Board ETag / conditional-GET", () => {
  const { app, db: database } = createTestApp();

  it("returns ETag on 200, serves 304 on matching If-None-Match, then 200 with new ETag after mutation", async () => {
    const pid = await createProjectDirectly(database, { name: "ETag Test Project" });
    const statusId = await createStatusDirectly(database, pid, "Todo", 0);

    // Seed one issue
    const issueRes = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ETag seed issue", statusId, projectId: pid }),
    });
    expect(issueRes.status).toBe(201);

    // First GET — expect 200 with ETag
    const res1 = await app.request(`/api/projects/${pid}/board`);
    expect(res1.status).toBe(200);
    const etag1 = res1.headers.get("ETag");
    expect(etag1).toBeTruthy();

    // Second GET with matching If-None-Match — expect 304 and no body
    const res2 = await app.request(`/api/projects/${pid}/board`, {
      headers: { "If-None-Match": etag1! },
    });
    expect(res2.status).toBe(304);
    const body2 = await res2.text();
    expect(body2).toBe("");

    // Mutate: create a new issue
    await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ETag mutation issue", statusId, projectId: pid }),
    });

    // Third GET with the old ETag — expect 200 with a new ETag
    const res3 = await app.request(`/api/projects/${pid}/board`, {
      headers: { "If-None-Match": etag1! },
    });
    expect(res3.status).toBe(200);
    const etag3 = res3.headers.get("ETag");
    expect(etag3).toBeTruthy();
    expect(etag3).not.toBe(etag1);
    const body3 = await res3.json() as any;
    const allIssues = body3.flatMap((col: any) => col.issues);
    expect(allIssues.length).toBe(2);
  });
});

