// @covers persistence-schema.enforce.unique-issue-number [error-handling]
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { applyMigrationsToClient } from "./helpers/test-db.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// Node-26 + libsql :memory: has a known cascade/teardown bug; use a file-backed DB
// (mirrors issues-batch.test.ts) so the unique-index enforcement is exercised on
// a real on-disk SQLite database.
const tempDirs: string[] = [];

function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "ak-unique-issuenum-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  applyMigrationsToClient(client);
  return drizzle(client, { schema }) as TestDb;
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: `/tmp/p-${projectId}`, repoName: `p-${projectId}`,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

function insertIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number) {
  const now = new Date().toISOString();
  return db.insert(schema.issues).values({
    id: randomUUID(), issueNumber, title: `I${issueNumber}`, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
}

describe("issues UNIQUE(project_id, issue_number) constraint", () => {
  let db: TestDb;
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    db = createTestDb();
    ({ projectId, statusId } = await seedProject(db));
  });

  it("REJECTS a second issue with a duplicate (project_id, issue_number)", async () => {
    // Two agents racing to claim #1 in the same project: only one can win.
    await insertIssue(db, projectId, statusId, 1);

    // libsql wraps the failure as "Failed query: insert into ..." with the
    // SQLite "UNIQUE constraint failed" detail on the error's `cause`. Assert
    // both: that it rejects at all, and that the underlying cause is the unique
    // index (so the test would NOT pass on some unrelated insert failure).
    const dupInsert = insertIssue(db, projectId, statusId, 1);
    await expect(dupInsert).rejects.toThrow();
    const err = await dupInsert.catch((e: unknown) => e);
    const detail = `${String((err as { message?: string })?.message ?? "")} ${String(
      (err as { cause?: unknown })?.cause ?? "",
    )}`;
    expect(detail).toMatch(/UNIQUE|constraint/i);

    // The first insert is the sole survivor — the duplicate never persisted.
    const rows = await db.select().from(schema.issues)
      .where(eq(schema.issues.issueNumber, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
  });

  it("ALLOWS a different issue_number in the same project", async () => {
    await expect(insertIssue(db, projectId, statusId, 2)).resolves.toBeDefined();

    const rows = await db.select().from(schema.issues);
    // #1 (single survivor) + #2.
    expect(rows.map((r) => r.issueNumber).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([1, 2]);
  });

  it("ALLOWS the same issue_number in a DIFFERENT project (scoped to project)", async () => {
    const other = await seedProject(db);
    await expect(insertIssue(db, other.projectId, other.statusId, 1)).resolves.toBeDefined();

    const rows = await db.select().from(schema.issues)
      .where(eq(schema.issues.projectId, other.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueNumber).toBe(1);
  });
});
