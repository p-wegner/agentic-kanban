import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { pruneOldSessionMessages, capSessionMessages } from "../services/session-message-pruner.service.js";

async function seedBase(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, createdAt: now, updatedAt: now });
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T", sortOrder: 0, createdAt: now, updatedAt: now });

  return { projectId, statusId, issueId, now };
}

async function insertWorkspace(db: ReturnType<typeof createTestDb>["db"], issueId: string, status: string, updatedAt: string, mergedAt?: string) {
  const id = randomUUID();
  await db.insert(workspaces).values({
    id,
    issueId,
    branch: `feature/${id.slice(0, 8)}`,
    workingDir: "/tmp/ws",
    status,
    updatedAt,
    createdAt: updatedAt,
    mergedAt: mergedAt ?? null,
  });
  return id;
}

async function insertSession(db: ReturnType<typeof createTestDb>["db"], workspaceId: string, startedAt: string) {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    workspaceId,
    status: "stopped",
    startedAt,
    endedAt: startedAt,
    createdAt: startedAt,
  });
  return id;
}

// Insert in multi-row batches, not one statement per row. The cap test needs 2010 rows;
// as 2010 separate awaited INSERTs that is 2010 round-trips, which is slow enough that the
// test measured machine load rather than the cap (#49 — it was the server package's
// last load flake). Rows still land in ascending-id order, which capSessionMessages'
// "delete the oldest" threshold depends on.
// CHUNK * 4 bound params per statement stays well under SQLite's 999-variable limit.
const INSERT_CHUNK = 200;

async function insertMessages(db: ReturnType<typeof createTestDb>["db"], sessionId: string, count: number) {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    sessionId,
    type: "stdout",
    data: `line ${i}`,
    createdAt: now,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(sessionMessages).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

describe("pruneOldSessionMessages", () => {
  it("deletes messages for old merged workspaces beyond the retention window", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
    const wsId = await insertWorkspace(db as any, issueId, "closed", oldDate, oldDate);
    const sessId = await insertSession(db as any, wsId, oldDate);
    await insertMessages(db as any, sessId, 5);

    const deleted = await pruneOldSessionMessages(db as any);
    expect(deleted).toBe(5);

    const remaining = await (db as any).select().from(sessionMessages);
    expect(remaining).toHaveLength(0);
  });

  it("does not delete messages for recently closed workspaces (within retention)", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const wsId = await insertWorkspace(db as any, issueId, "closed", recentDate, recentDate);
    const sessId = await insertSession(db as any, wsId, recentDate);
    await insertMessages(db as any, sessId, 3);

    const deleted = await pruneOldSessionMessages(db as any);
    expect(deleted).toBe(0);

    const remaining = await (db as any).select().from(sessionMessages);
    expect(remaining).toHaveLength(3);
  });

  it("does not delete messages for active workspaces", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const wsId = await insertWorkspace(db as any, issueId, "active", oldDate);
    const sessId = await insertSession(db as any, wsId, oldDate);
    await insertMessages(db as any, sessId, 4);

    const deleted = await pruneOldSessionMessages(db as any);
    expect(deleted).toBe(0);
  });

  it("accepts a nowOverride for deterministic time-based tests", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    // Workspace closed "2 days ago" relative to now, but we override 'now' to 5 days later
    const closedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fakeNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 5 days after closed
    const wsId = await insertWorkspace(db as any, issueId, "closed", closedAt, closedAt);
    const sessId = await insertSession(db as any, wsId, closedAt);
    await insertMessages(db as any, sessId, 2);

    const deleted = await pruneOldSessionMessages(db as any, fakeNow);
    expect(deleted).toBe(2);
  });
});

describe("capSessionMessages", () => {
  it("removes oldest messages beyond the per-session cap", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    const now = new Date().toISOString();
    const wsId = await insertWorkspace(db as any, issueId, "active", now);
    const sessId = await insertSession(db as any, wsId, now);

    // Insert 2010 messages (10 over the 2000 cap)
    await insertMessages(db as any, sessId, 2010);

    const capped = await capSessionMessages(db as any);
    expect(capped).toBe(10);

    const remaining = await (db as any).select().from(sessionMessages).where(
      (await import("drizzle-orm")).eq(sessionMessages.sessionId, sessId)
    );
    expect(remaining.length).toBe(2000);
  });

  it("does nothing for sessions within the cap", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedBase(db as any);

    const now = new Date().toISOString();
    const wsId = await insertWorkspace(db as any, issueId, "active", now);
    const sessId = await insertSession(db as any, wsId, now);
    await insertMessages(db as any, sessId, 10);

    const capped = await capSessionMessages(db as any);
    expect(capped).toBe(0);
  });
});
