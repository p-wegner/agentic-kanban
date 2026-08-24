import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createSessionState } from "../services/session-manager/types.js";

// Route the broadcast repository (writeDb) at a real migrated test DB so the
// insert-time cap (#404) is exercised end-to-end: real inserts, real indexed
// threshold lookup, real ranged delete.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const { db } = createTestDb();
  return { db, writeDb: db };
});

// Silence noise from broadcast internals
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

const { writeDb } = await import("../db/index.js");
const { createBroadcaster } = await import("../services/session-manager/broadcast.js");
const db = writeDb as unknown as import("./helpers/test-db.js").TestDb;

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, createdAt: now });
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T", sortOrder: 0, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/cap", workingDir: "/tmp/ws", status: "active", createdAt: now, updatedAt: now });
  await db.insert(sessions).values({ id: sessionId, workspaceId, status: "running", startedAt: now });
  return sessionId;
}

async function countRows(sessionId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
  return Number(rows[0].count);
}

/** Wait until the fire-and-forget insert/cap chains have settled (stable count twice in a row). */
async function waitForStableCount(sessionId: string): Promise<number> {
  let prev = -1;
  for (let i = 0; i < 200; i++) {
    const c = await countRows(sessionId);
    if (c === prev) return c;
    prev = c;
    await new Promise((r) => setTimeout(r, 25));
  }
  return prev;
}

describe("insert-time session_messages cap — acceptance (#404)", () => {
  it("a session that emits far more than 2000 persisted lines never materially exceeds ~2000 rows", async () => {
    const sessionId = await seedSession();
    const state = createSessionState();
    const broadcast = createBroadcaster(state, undefined);

    // 5000 non-stdout lines = 100 batch-size flushes; the cap fires every 8th
    // flush, so the table is trimmed repeatedly WHILE the session streams —
    // not hours later by the periodic pruner.
    const TOTAL = 5000;
    for (let i = 0; i < TOTAL; i++) {
      broadcast(sessionId, { sessionId, type: "stderr", data: `line ${i}` });
    }

    const count = await waitForStableCount(sessionId);

    // Cap is 2000; allowed slack between trims is CAP_EVERY_N_FLUSHES (8) *
    // DB_FLUSH_BATCH_SIZE (50) = 400 rows.
    expect(count).toBeGreaterThanOrEqual(2000);
    expect(count).toBeLessThanOrEqual(2400);

    // The NEWEST rows survive; the oldest were ring-buffered away.
    const remaining = await db
      .select({ data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId));
    const datas = remaining.map((r) => r.data);
    expect(datas).toContain(`line ${TOTAL - 1}`);
    expect(datas).not.toContain("line 0");
  }, 30_000);
});
