import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Verifies the composite index idx_session_messages_session_id_created_at exists
 * and that session output queries return messages in created_at order.
 */
describe("session_messages composite index", () => {
  it("index idx_session_messages_session_id_created_at exists in schema", async () => {
    const { client } = createTestDb();
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_messages' AND name='idx_session_messages_session_id_created_at'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe("idx_session_messages_session_id_created_at");
  });

  it("query plan uses the composite index for session output access pattern", async () => {
    const { client } = createTestDb();
    const plan = await client.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM session_messages WHERE session_id = 'test-id' ORDER BY created_at ASC",
    );
    const planText = plan.rows.map((r) => Object.values(r).join(" ")).join("\n");
    expect(planText).toContain("idx_session_messages_session_id_created_at");
  });

  it("returns messages in created_at order for a session", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
      statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/test", workingDir: "/tmp/repo/.worktrees/test",
      baseBranch: "main", isDirect: false, status: "active", provider: "claude",
      skillId: null, createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({
      id: sessionId, workspaceId, executor: "claude-code", status: "running",
      startedAt: now,
    });

    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    const t3 = new Date(Date.now()).toISOString();

    await db.insert(sessionMessages).values([
      { sessionId, type: "stdout", data: "third", createdAt: t3 },
      { sessionId, type: "stdout", data: "first", createdAt: t1 },
      { sessionId, type: "stdout", data: "second", createdAt: t2 },
    ]);

    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.createdAt);

    expect(rows.map((r) => r.data)).toEqual(["first", "second", "third"]);
  });
});
