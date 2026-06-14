import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, preferences, projects, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { scanAutodriveStallWarnings } from "../services/autodrive-stall-warning.service.js";

const NOW = new Date("2026-06-14T12:00:00.000Z");

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

async function seedProject(database: TestDb) {
  const projectId = randomUUID();
  await database.insert(projects).values({
    id: projectId,
    name: "Autodrive Project",
    repoPath: `C:/tmp/${projectId}`,
    repoName: "autodrive-project",
    defaultBranch: "main",
    createdAt: minutesAgo(120),
    updatedAt: minutesAgo(120),
  });

  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const doneId = randomUUID();
  await database.insert(projectStatuses).values([
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: minutesAgo(120) },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: minutesAgo(120) },
    { id: doneId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: minutesAgo(120) },
  ]);

  await database.insert(preferences).values([
    { key: `board_autodrive_${projectId}`, value: "true", updatedAt: minutesAgo(120) },
    { key: "monitor_stall_warning_min", value: "20", updatedAt: minutesAgo(120) },
  ]);

  return { projectId, inProgressId, inReviewId, doneId };
}

async function addIssue(database: TestDb, projectId: string, statusId: string, updatedAt: string, issueNumber = 1) {
  const issueId = randomUUID();
  await database.insert(issues).values({
    id: issueId,
    issueNumber,
    title: "Build the thing",
    issueType: "task",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: minutesAgo(120),
    updatedAt,
    statusChangedAt: updatedAt,
  });
  return issueId;
}

async function addWorkspace(database: TestDb, issueId: string, status: string, updatedAt: string, extra: Partial<typeof workspaces.$inferInsert> = {}) {
  const workspaceId = randomUUID();
  await database.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/test",
    workingDir: "C:/tmp/worktree",
    baseBranch: "main",
    status,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  });
  return workspaceId;
}

describe("scanAutodriveStallWarnings", () => {
  it("warns for an auto-driven project with a stale zero-token running builder", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);
    const issueId = await addIssue(db, projectId, inProgressId, minutesAgo(45));
    const workspaceId = await addWorkspace(db, issueId, "active", minutesAgo(45));
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: minutesAgo(45),
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
      triggerType: "agent",
    });

    const warnings = await scanAutodriveStallWarnings(db, undefined, NOW);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: "autodrive_stall",
      projectId,
      cause: "hung_zero_token_builder",
      thresholdMin: 20,
    });
    expect(warnings[0].message).toContain("no forward progress for 45m");
  });

  it("does not warn for an auto-driven project with no active workspace", async () => {
    const { db } = createTestDb();
    await seedProject(db);

    await expect(scanAutodriveStallWarnings(db, undefined, NOW)).resolves.toEqual([]);
  });

  it("does not warn when progress is inside the configured window", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);
    const issueId = await addIssue(db, projectId, inProgressId, minutesAgo(5));
    const workspaceId = await addWorkspace(db, issueId, "active", minutesAgo(5));
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: minutesAgo(5),
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });

    await expect(scanAutodriveStallWarnings(db, undefined, NOW)).resolves.toEqual([]);
  });

  it("does not warn when another ticket in the project merged recently", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, doneId } = await seedProject(db);
    const staleIssueId = await addIssue(db, projectId, inProgressId, minutesAgo(45), 1);
    const staleWorkspaceId = await addWorkspace(db, staleIssueId, "active", minutesAgo(45));
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: staleWorkspaceId,
      executor: "codex",
      status: "running",
      startedAt: minutesAgo(45),
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });

    const mergedIssueId = await addIssue(db, projectId, doneId, minutesAgo(3), 2);
    await addWorkspace(db, mergedIssueId, "closed", minutesAgo(3), { mergedAt: minutesAgo(3), closedAt: minutesAgo(3) });

    await expect(scanAutodriveStallWarnings(db, undefined, NOW)).resolves.toEqual([]);
  });

  it("clears once progress resumes", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);
    const issueId = await addIssue(db, projectId, inProgressId, minutesAgo(45));
    const workspaceId = await addWorkspace(db, issueId, "active", minutesAgo(45));
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: minutesAgo(45),
      stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });

    expect(await scanAutodriveStallWarnings(db, undefined, NOW)).toHaveLength(1);

    await db.update(workspaces).set({ updatedAt: minutesAgo(1) });

    await expect(scanAutodriveStallWarnings(db, undefined, NOW)).resolves.toEqual([]);
  });

  it("classifies an In-Review auto-merge stall", async () => {
    const { db } = createTestDb();
    const { projectId, inReviewId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: "auto_merge", value: "true", updatedAt: minutesAgo(120) },
      { key: "auto_merge_in_review", value: "true", updatedAt: minutesAgo(120) },
    ]);
    const issueId = await addIssue(db, projectId, inReviewId, minutesAgo(30));
    await addWorkspace(db, issueId, "idle", minutesAgo(30));

    const warnings = await scanAutodriveStallWarnings(db, undefined, NOW);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].cause).toBe("in_review_auto_merge_stalled");
  });
});
