import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./helpers/migrations.js";
import type { TestDb } from "./helpers/test-db.js";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";

const tempClients: ReturnType<typeof createClient>[] = [];

afterEach(async () => {
  for (const client of tempClients.splice(0)) {
    await client.close();
  }
});

async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "ak-reconcile-issue-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  tempClients.push(client);
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }
  return drizzle(client, { schema });
}

async function seedIssue(
  db: TestDb,
  opts: { includeDone?: boolean; includeAiReviewed?: boolean; startStatus?: "In Review" | "Done" } = {},
) {
  const includeDone = opts.includeDone ?? true;
  const now = "2026-06-08T10:00:00.000Z";
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const aiReviewedStatusId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Reconcile issue test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });

  const statusRows: (typeof projectStatuses.$inferInsert)[] = [
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
  ];
  if (includeDone) {
    statusRows.push({ id: doneStatusId, projectId, name: "Done", sortOrder: 4, isDefault: false, createdAt: now });
  }
  if (opts.includeAiReviewed) {
    statusRows.push({ id: aiReviewedStatusId, projectId, name: "AI Reviewed", sortOrder: 3, isDefault: false, createdAt: now });
  }
  await db.insert(projectStatuses).values(statusRows);

  const startStatusId = opts.startStatus === "Done" ? doneStatusId : inReviewStatusId;
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 689,
    title: "Extract reconcileMergedIssue",
    priority: "medium",
    sortOrder: 0,
    statusId: startStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, inReviewStatusId, doneStatusId, aiReviewedStatusId };
}

describe("reconcileMergedIssue", () => {
  it("moves an In Review issue to Done", async () => {
    const db = await createTestDb();
    const { projectId, issueId, doneStatusId } = await seedIssue(db);

    const result = await reconcileMergedIssue({
      database: db,
      issueId,
      now: "2026-06-08T10:05:00.000Z",
    });

    expect(result).toEqual({ projectId, issueTransitioned: true, targetStatusId: doneStatusId });

    const [issue] = await db
      .select({ statusId: issues.statusId, statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneStatusId);
    expect(issue.statusChangedAt).toBe("2026-06-08T10:05:00.000Z");
  });

  it("is idempotent: calling twice is safe and does not rewrite statusChangedAt", async () => {
    const db = await createTestDb();
    const { issueId, doneStatusId } = await seedIssue(db);

    const first = await reconcileMergedIssue({
      database: db,
      issueId,
      now: "2026-06-08T10:05:00.000Z",
    });
    const second = await reconcileMergedIssue({
      database: db,
      issueId,
      now: "2026-06-08T10:06:00.000Z",
    });

    expect(first.issueTransitioned).toBe(true);
    // Second call is a no-op — the issue is already Done.
    expect(second.issueTransitioned).toBe(false);
    expect(second.targetStatusId).toBe(doneStatusId);

    const [issue] = await db
      .select({ statusId: issues.statusId, statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneStatusId);
    // statusChangedAt reflects the FIRST transition, not the repeat call.
    expect(issue.statusChangedAt).toBe("2026-06-08T10:05:00.000Z");
  });

  it("dropped-response path: a sweep converges an issue left In Review after a merge", async () => {
    // Simulates a merge whose HTTP response dropped before the issue transition
    // ran — the issue is still In Review while the branch is already on master.
    // The post-merge sweep calls reconcileMergedIssue and it converges to Done.
    const db = await createTestDb();
    const { issueId, doneStatusId, inReviewStatusId } = await seedIssue(db);

    const [before] = await db
      .select({ statusId: issues.statusId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(before.statusId).toBe(inReviewStatusId);

    const result = await reconcileMergedIssue({
      database: db,
      issueId,
      now: "2026-06-08T10:10:00.000Z",
    });
    expect(result.issueTransitioned).toBe(true);

    const [after] = await db
      .select({ statusId: issues.statusId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(after.statusId).toBe(doneStatusId);
  });

  it("is a no-op when the issue is already Done", async () => {
    const db = await createTestDb();
    const { issueId, doneStatusId } = await seedIssue(db, { startStatus: "Done" });

    const result = await reconcileMergedIssue({ database: db, issueId, now: "2026-06-08T11:00:00.000Z" });

    expect(result.issueTransitioned).toBe(false);
    expect(result.targetStatusId).toBe(doneStatusId);

    const [issue] = await db
      .select({ statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));
    // Untouched — still the seed timestamp, not the reconcile timestamp.
    expect(issue.statusChangedAt).toBe(null);
  });

  it("falls back to AI Reviewed when no Done status exists and fallback is requested", async () => {
    const db = await createTestDb();
    const { issueId, aiReviewedStatusId } = await seedIssue(db, {
      includeDone: false,
      includeAiReviewed: true,
    });

    const result = await reconcileMergedIssue({
      database: db,
      issueId,
      now: "2026-06-08T10:05:00.000Z",
      fallbackToAiReviewed: true,
    });

    expect(result.issueTransitioned).toBe(true);
    expect(result.targetStatusId).toBe(aiReviewedStatusId);
  });

  it("does not fall back to AI Reviewed unless requested", async () => {
    const db = await createTestDb();
    const { issueId } = await seedIssue(db, { includeDone: false, includeAiReviewed: true });

    const result = await reconcileMergedIssue({ database: db, issueId, now: "2026-06-08T10:05:00.000Z" });

    // No Done status, fallback not requested → nothing to transition to.
    expect(result.issueTransitioned).toBe(false);
    expect(result.targetStatusId).toBe(null);
  });

  it("throws when the issue does not exist", async () => {
    const db = await createTestDb();
    await expect(
      reconcileMergedIssue({ database: db, issueId: randomUUID() }),
    ).rejects.toThrow(/Issue not found/);
  });
});
