import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getIssueActivity } from "../services/issue-activity.service.js";

let db: TestDb;
let projectId: string;
let statusId: string;
let issueId: string;

beforeAll(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test Issue",
    statusId,
    projectId,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: now,
    statusChangedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
});

describe("getIssueActivity", () => {
  it("returns null for unknown issue", async () => {
    const result = await getIssueActivity(randomUUID(), db);
    expect(result).toBeNull();
  });

  it("returns issue_created event", async () => {
    const result = await getIssueActivity(issueId, db);
    expect(result).not.toBeNull();
    const created = result!.events.find((e) => e.type === "issue_created");
    expect(created).toBeDefined();
    expect(created!.actor).toBe("user");
  });

  it("returns status_changed event when statusChangedAt differs from createdAt", async () => {
    const result = await getIssueActivity(issueId, db);
    const changed = result!.events.find((e) => e.type === "status_changed");
    expect(changed).toBeDefined();
    expect(changed!.summary).toContain("In Progress");
  });

  it("events are sorted newest-first", async () => {
    const result = await getIssueActivity(issueId, db);
    const timestamps = result!.events.map((e) => e.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] >= timestamps[i]).toBe(true);
    }
  });

  it("includes workspace + session events", async () => {
    const wsId = randomUUID();
    const wsCreatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const wsMergedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId,
      branch: "feature/test",
      status: "merged",
      createdAt: wsCreatedAt,
      updatedAt: wsMergedAt,
      mergedAt: wsMergedAt,
    });

    const sessId = randomUUID();
    const sessStartedAt = new Date(Date.now() - 18 * 60 * 1000).toISOString();
    const sessEndedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await db.insert(schema.sessions).values({
      id: sessId,
      workspaceId: wsId,
      executor: "claude-code",
      status: "completed",
      startedAt: sessStartedAt,
      endedAt: sessEndedAt,
      exitCode: "0",
    });

    const result = await getIssueActivity(issueId, db);
    expect(result).not.toBeNull();

    const wsCreated = result!.events.find((e) => e.type === "workspace_created" && e.workspaceId === wsId);
    expect(wsCreated).toBeDefined();
    expect(wsCreated!.summary).toContain("feature/test");

    const wsMerged = result!.events.find((e) => e.type === "workspace_merged" && e.workspaceId === wsId);
    expect(wsMerged).toBeDefined();

    const sessStarted = result!.events.find((e) => e.type === "session_started" && e.sessionId === sessId);
    expect(sessStarted).toBeDefined();
    expect(sessStarted!.actor).toBe("claude-code");

    const sessCompleted = result!.events.find((e) => e.type === "session_completed" && e.sessionId === sessId);
    expect(sessCompleted).toBeDefined();
  });

  it("includes comment events", async () => {
    const cmtId = randomUUID();
    await db.insert(schema.issueComments).values({
      id: cmtId,
      issueId,
      kind: "note",
      author: "user",
      body: "Test note body",
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });

    const result = await getIssueActivity(issueId, db);
    const cmtEvent = result!.events.find((e) => e.id === `comment-${cmtId}`);
    expect(cmtEvent).toBeDefined();
    expect(cmtEvent!.type).toBe("comment");
    expect(cmtEvent!.commentKind).toBe("note");
    expect(cmtEvent!.summary).toContain("Test note body");
    expect(cmtEvent!.actor).toBe("user");
  });
});
