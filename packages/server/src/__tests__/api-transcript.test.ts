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

describe("Transcript Search API", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;
  // Deterministic, unique per-issue number: seedSession accumulates several issues
  // in the one shared project, and migration 0094 makes (project_id, issue_number)
  // UNIQUE — a random number risked a birthday collision (and hitting the fixed 8888).
  let transcriptIssueSeq = 1000;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Transcript Search Project" });
    statusId = await createStatusDirectly(database, projectId, "In Progress", 0);
  });

  async function seedSession(overrides: {
    issueTitle: string;
    branch: string;
    executor?: string;
    statusName?: string;
    messages: { type: string; data: string }[];
  }) {
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    // Optionally create a separate status for this issue
    let sid = statusId;
    if (overrides.statusName && overrides.statusName !== "In Progress") {
      sid = await createStatusDirectly(database, projectId, overrides.statusName, 10);
    }

    await database.insert(schema.issues).values({
      id: issueId,
      projectId,
      statusId: sid,
      issueNumber: transcriptIssueSeq++,
      title: overrides.issueTitle,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: overrides.branch,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: overrides.executor ?? "claude-code",
      status: "completed",
      startedAt: now,
    });
    for (const msg of overrides.messages) {
      await database.insert(schema.sessionMessages).values({
        sessionId,
        type: msg.type,
        data: msg.data,
        createdAt: now,
      });
    }
    return { issueId, workspaceId, sessionId };
  }

  it("returns matching results for a search query", async () => {
    await seedSession({
      issueTitle: "Fix auth bug",
      branch: "feature/auth-fix",
      messages: [
        { type: "stdout", data: "Error: Cannot read property 'token' of undefined at AuthService" },
        { type: "stdout", data: "Fixed by adding null check in auth middleware" },
      ],
    });

    const res = await app.request(`/api/sessions/search?q=token&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].snippet).toContain("token");
    expect(body.results[0].issueTitle).toBe("Fix auth bug");
    expect(body.results[0].branch).toBe("feature/auth-fix");
    expect(body.results[0].projectId).toBe(projectId);
    expect(body.results[0].projectName).toBe("Transcript Search Project");
    expect(body.results[0].executor).toBe("claude-code");
  });

  it("returns empty results for non-matching query", async () => {
    const res = await app.request(`/api/sessions/search?q=zzzznonexistent&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("searches globally when projectId is omitted", async () => {
    const otherProjectId = await createProjectDirectly(database, { name: "Other Transcript Project" });
    const otherStatusId = await createStatusDirectly(database, otherProjectId, "Done", 0);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId,
      projectId: otherProjectId,
      statusId: otherStatusId,
      issueNumber: 287,
      title: "Implemented elsewhere",
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/ak-287",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId,
      workspaceId,
      executor: "codex",
      status: "completed",
      startedAt: now,
    });
    await database.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data: "GlobalNeedle implementation notes and problems",
      createdAt: now,
    });

    const res = await app.request("/api/sessions/search?q=GlobalNeedle");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      sessionId,
      projectId: otherProjectId,
      projectName: "Other Transcript Project",
      issueNumber: 287,
      issueTitle: "Implemented elsewhere",
    });
  });

  it("returns empty for query shorter than 2 chars", async () => {
    const res = await app.request(`/api/sessions/search?q=a&projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("filters by status", async () => {
    const doneStatusId = await createStatusDirectly(database, projectId, "Done", 20);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await database.insert(schema.issues).values({
      id: issueId, projectId, statusId: doneStatusId,
      issueNumber: 8888, title: "Completed task", priority: "medium", issueType: "task",
      sortOrder: 0, createdAt: now, updatedAt: now,
    });
    await database.insert(schema.workspaces).values({
      id: workspaceId, issueId, branch: "feature/done-task",
      status: "closed", createdAt: now, updatedAt: now,
    });
    await database.insert(schema.sessions).values({
      id: sessionId, workspaceId, executor: "claude-code",
      status: "completed", startedAt: now,
    });
    await database.insert(schema.sessionMessages).values({
      sessionId, type: "stdout",
      data: "Searching for token in completed task",
      createdAt: now,
    });

    // Filter by "Done" — should match
    const doneRes = await app.request(`/api/sessions/search?q=token&projectId=${projectId}&status=Done`);
    expect(doneRes.status).toBe(200);
    const doneBody = await doneRes.json() as any;
    expect(doneBody.results.some((r: any) => r.issueTitle === "Completed task")).toBe(true);

    // Filter by "In Progress" — should NOT match the done issue
    const activeRes = await app.request(`/api/sessions/search?q=token&projectId=${projectId}&status=In Progress`);
    expect(activeRes.status).toBe(200);
    const activeBody = await activeRes.json() as any;
    expect(activeBody.results.some((r: any) => r.issueTitle === "Completed task")).toBe(false);
  });

  it("filters by provider", async () => {
    await seedSession({
      issueTitle: "Codex search test",
      branch: "feature/codex-test",
      executor: "codex",
      messages: [
        { type: "stdout", data: "Codex found the authentication error" },
      ],
    });

    // Filter by codex
    const codexRes = await app.request(`/api/sessions/search?q=authentication&projectId=${projectId}&provider=codex`);
    expect(codexRes.status).toBe(200);
    const codexBody = await codexRes.json() as any;
    expect(codexBody.results.length).toBeGreaterThanOrEqual(1);
    expect(codexBody.results.every((r: any) => r.executor === "codex")).toBe(true);
  });

  it("respects limit parameter", async () => {
    // Seed 3 sessions with the same keyword
    for (let i = 0; i < 3; i++) {
      await seedSession({
        issueTitle: `Limit test ${i}`,
        branch: `feature/limit-${i}`,
        messages: [
          { type: "stdout", data: `UniqueLimitKeyword found in result ${i}` },
        ],
      });
    }

    const res = await app.request(`/api/sessions/search?q=UniqueLimitKeyword&projectId=${projectId}&limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results.length).toBe(2);
  });
});
