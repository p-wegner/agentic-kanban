import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createVoiceCaptureIssue } from "../services/voice-capture.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { invokeClaudePrompt } from "../services/claude-cli.service.js";

vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: vi.fn(),
}));

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const backlogId = randomUUID();

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

  return { projectId, backlogId };
}

describe("createVoiceCaptureIssue", () => {
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

    expect(result.priority).toBe("critical");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.id, result.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].statusId).toBe(backlogId);
  });
});
