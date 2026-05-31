import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createVoiceCaptureIssue, parseVoiceCommandIntent } from "../services/voice-capture.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { invokeClaudePrompt } from "../services/claude-cli.service.js";

vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: vi.fn(),
}));

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const backlogId = randomUUID();
  const reviewId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Voice Capture Test",
    repoPath: "/tmp/voice-capture-test",
    repoName: "voice-capture-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectStatuses).values({
    id: backlogId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  await db.insert(schema.projectStatuses).values({
    id: reviewId,
    projectId,
    name: "In Review",
    sortOrder: 2,
    isDefault: false,
    createdAt: now,
  });

  return { projectId, backlogId, reviewId };
}

describe("createVoiceCaptureIssue", () => {
  beforeEach(() => {
    vi.mocked(invokeClaudePrompt).mockReset();
  });

  it("distinguishes move commands from issue creation notes", () => {
    expect(parseVoiceCommandIntent("move #10 to review")).toEqual({
      type: "move_issue",
      issueNumber: 10,
      targetStatus: "review",
    });
    expect(parseVoiceCommandIntent("capture a ticket about flaky tests")).toEqual({ type: "create_issue" });
  });

  it("normalizes urgent AI priority to the canonical critical issue priority", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedProject(db);
    vi.mocked(invokeClaudePrompt).mockResolvedValue(JSON.stringify({
      title: "Fix production outage",
      description: "## Voice Transcript\nFix production outage now.",
      priority: "urgent",
    }));

    const result = await createVoiceCaptureIssue({
      projectId,
      transcript: "Fix production outage now.",
    }, db);

    expect(result).toMatchObject({ type: "issue", priority: "critical" });

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.id, result.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].statusId).toBe(backlogId);
  });

  it("moves an issue from a voice command without creating a new issue", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId, reviewId } = await seedProject(db);
    const issueId = randomUUID();
    const now = new Date().toISOString();
    const broadcast = vi.fn();

    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 5,
      title: "Existing task",
      description: null,
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      statusId: backlogId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });

    const result = await createVoiceCaptureIssue({
      projectId,
      transcript: "move issue number 5 to review",
    }, db, { broadcast } as any);

    expect(result).toMatchObject({
      type: "action",
      action: "move_issue",
      issueNumber: 5,
      targetStatus: "In Review",
    });
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(projectId, "issue_updated");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].statusId).toBe(reviewId);
  });
});
