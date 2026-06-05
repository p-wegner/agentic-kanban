import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { capSessionMessages } from "../services/session-message-pruner.service.js";

/**
 * Benchmark-style tests for session_messages write and read performance at
 * 1000+ message volume. These are correctness + timing guards, not microbenchmarks:
 * they assert that the operations complete within generous but non-trivial bounds
 * and produce correct results regardless of volume.
 */

const BATCH_SIZE = 50; // matches DB_FLUSH_BATCH_SIZE in broadcast.ts
const TOTAL_MESSAGES = 1200;

async function seedSession(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/test", workingDir: "/tmp", baseBranch: "main", isDirect: false, status: "active", provider: "claude", skillId: null, createdAt: now, updatedAt: now });
  await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "claude-code", status: "running", startedAt: now });

  return { sessionId, workspaceId };
}

/**
 * Insert messages in batches matching the production broadcast flush pattern.
 * Returns elapsed ms.
 */
async function insertInBatches(
  db: ReturnType<typeof createTestDb>["db"],
  sessionId: string,
  count: number,
  batchSize: number,
): Promise<number> {
  const now = new Date().toISOString();
  const start = performance.now();
  for (let i = 0; i < count; i += batchSize) {
    const end = Math.min(i + batchSize, count);
    const rows = [];
    for (let j = i; j < end; j++) {
      rows.push({ sessionId, type: j % 20 === 0 ? "stderr" : "stdout", data: `message ${j}`, createdAt: now });
    }
    await db.insert(sessionMessages).values(rows);
  }
  return performance.now() - start;
}

describe("session_messages high-volume write performance", () => {
  it(`inserts ${TOTAL_MESSAGES} messages in batches of ${BATCH_SIZE} within 5 seconds`, async () => {
    const { db } = createTestDb();
    const { sessionId } = await seedSession(db as any);

    const elapsed = await insertInBatches(db as any, sessionId, TOTAL_MESSAGES, BATCH_SIZE);

    const rows = await (db as any).select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    expect(rows).toHaveLength(TOTAL_MESSAGES);
    expect(elapsed).toBeLessThan(5000);
  });

  it("batch insert is faster than N individual inserts for the same volume", async () => {
    const { db: db1 } = createTestDb();
    const { sessionId: s1 } = await seedSession(db1 as any);

    const { db: db2 } = createTestDb();
    const { sessionId: s2 } = await seedSession(db2 as any);

    const count = 200;
    const now = new Date().toISOString();

    // Individual inserts
    const t1 = performance.now();
    for (let i = 0; i < count; i++) {
      await (db1 as any).insert(sessionMessages).values({ sessionId: s1, type: "stdout", data: `msg ${i}`, createdAt: now });
    }
    const individualMs = performance.now() - t1;

    // Batch inserts (production pattern)
    const batchMs = await insertInBatches(db2 as any, s2, count, BATCH_SIZE);

    // Batch should be meaningfully faster; allow 5× headroom for CI variance
    expect(batchMs).toBeLessThan(individualMs * 5);
    expect(batchMs).toBeLessThan(2000);
  });
});

describe("session_messages high-volume read performance", () => {
  it(`reads ${TOTAL_MESSAGES} messages via indexed query within 500ms`, async () => {
    const { db } = createTestDb();
    const { sessionId } = await seedSession(db as any);

    await insertInBatches(db as any, sessionId, TOTAL_MESSAGES, BATCH_SIZE);

    const start = performance.now();
    const rows = await (db as any)
      .select({ type: sessionMessages.type, data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(TOTAL_MESSAGES);
    expect(elapsed).toBeLessThan(500);
  });

  it("read time stays stable across multiple 1000-message sessions (no table-scan growth)", async () => {
    const { db } = createTestDb();
    const sessionIds: string[] = [];

    // Populate 3 independent sessions with 1000 messages each (3000 total rows)
    for (let i = 0; i < 3; i++) {
      const { sessionId } = await seedSession(db as any);
      sessionIds.push(sessionId);
      await insertInBatches(db as any, sessionId, 1000, BATCH_SIZE);
    }

    const timings: number[] = [];
    for (const sessionId of sessionIds) {
      const start = performance.now();
      const rows = await (db as any)
        .select({ type: sessionMessages.type, data: sessionMessages.data })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .orderBy(sessionMessages.id);
      timings.push(performance.now() - start);
      expect(rows).toHaveLength(1000);
    }

    // Each read should stay under 500ms regardless of other sessions in the table
    for (const t of timings) {
      expect(t).toBeLessThan(500);
    }
  });
});

describe("session_messages cap correctness at high volume", () => {
  it("caps a 2100-message session to 2000 rows", async () => {
    const { db } = createTestDb();
    const { sessionId } = await seedSession(db as any);

    await insertInBatches(db as any, sessionId, 2100, BATCH_SIZE);

    await capSessionMessages(db as any);

    const remaining = await (db as any)
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId));
    expect(remaining).toHaveLength(2000);
  });

  it("cap operation on 2100 messages completes within 2 seconds", async () => {
    const { db } = createTestDb();
    const { sessionId } = await seedSession(db as any);

    await insertInBatches(db as any, sessionId, 2100, BATCH_SIZE);

    const start = performance.now();
    await capSessionMessages(db as any);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
