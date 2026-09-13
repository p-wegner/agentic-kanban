/**
 * #1131 — re-decomposing an epic must be told what already exists, so it proposes only
 * NEW, non-overlapping work instead of duplicating a shipped child. Asserts the PROMPT
 * carries the existing children + statuses and the "propose only new work" instruction,
 * and that `DecomposeEpicResult.existingChildren` reflects the epic's real children.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { decomposeEpic } from "../services/issue-ai.service.js";
import { invokeClaudePrompt } from "../services/claude-cli.service.js";

vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: vi.fn(),
}));

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const backlogId = randomUUID();
  const doneId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: backlogId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now },
    { id: doneId, projectId, name: "Done", sortOrder: 5, isDefault: false, createdAt: now },
  ]);
  return { projectId, backlogId, doneId };
}

async function insertIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number, title: string, description = "") {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber, title, description, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

async function parentOf(db: TestDb, epicId: string, childId: string) {
  await db.insert(schema.issueDependencies).values({
    id: randomUUID(), issueId: epicId, dependsOnId: childId, type: "parent_of", createdAt: new Date().toISOString(),
  });
}

describe("decomposeEpic — extension-aware prompt context (#1131)", () => {
  beforeEach(() => {
    vi.mocked(invokeClaudePrompt).mockReset();
    vi.mocked(invokeClaudePrompt).mockResolvedValue(JSON.stringify({ children: [], dependencies: [] }));
  });

  it("feeds existing children + status into the prompt and instructs no duplicates", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId, doneId } = await seedProject(db);
    const epic = await insertIssue(db, projectId, backlogId, 1, "Jira epic", "Big epic body");
    const done1 = await insertIssue(db, projectId, doneId, 2, "Implement login form");
    const open1 = await insertIssue(db, projectId, backlogId, 3, "Wire up SSO");
    await parentOf(db, epic, done1);
    await parentOf(db, epic, open1);

    const result = await decomposeEpic(epic, projectId, db as any);

    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(invokeClaudePrompt).mock.calls[0][0] as string;

    expect(prompt).toContain("#2 Implement login form [Done]");
    expect(prompt).toContain("#3 Wire up SSO [Backlog]");
    expect(prompt).toMatch(/only new work/i);
    expect(prompt).toMatch(/do not duplicate/i);

    expect(result.existingChildren).toEqual([
      { issueNumber: 2, title: "Implement login form", statusName: "Done" },
      { issueNumber: 3, title: "Wire up SSO", statusName: "Backlog" },
    ]);
    expect(result.alreadyDecomposed).toBe(true);
  });

  it("is byte-for-byte today's behaviour when the epic has no children yet", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedProject(db);
    const epic = await insertIssue(db, projectId, backlogId, 1, "Fresh epic", "Body");

    const result = await decomposeEpic(epic, projectId, db as any);

    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(invokeClaudePrompt).mock.calls[0][0] as string;

    expect(prompt).not.toContain("already has these child tickets");
    expect(prompt).not.toMatch(/only new work/i);

    expect(result.existingChildren).toEqual([]);
    expect(result.alreadyDecomposed).toBe(false);
  });
});
