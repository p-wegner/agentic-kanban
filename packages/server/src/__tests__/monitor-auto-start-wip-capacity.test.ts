import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projects, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { countActiveWip } from "../startup/monitor-auto-start.js";

/**
 * Regression for #690: provider usage-limit / zero-output launch failures must
 * NOT occupy WIP capacity. Such workspaces are persisted as `blocked` (codex
 * usage-limit) or `idle` (zero-output launch failure) — both with a stopped,
 * zero-token launch-failure session and zero diff. The old auto-start WIP count
 * (`status != 'closed'`) treated them as active, so the board showed In-Progress
 * issues but zero working agents and refused to auto-start anything.
 *
 * `countActiveWip` must count only workspaces actively running an agent.
 */

async function seed(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "WIP Capacity Project",
    repoPath: "/tmp/wip-capacity",
    repoName: "wip-capacity",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const inProgressId = randomUUID();
  await db.insert(projectStatuses).values({
    id: inProgressId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: false,
    createdAt: now,
  });

  return { projectId, inProgressId, now };
}

let issueCounter = 1;
async function addIssue(db: TestDb, projectId: string, statusId: string, now: string) {
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: issueCounter++,
    title: "WIP issue",
    issueType: "task",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function addWorkspace(db: TestDb, issueId: string, status: string, now: string) {
  const id = randomUUID();
  await db.insert(workspaces).values({
    id,
    issueId,
    branch: "feature/test",
    workingDir: "/tmp/wip-capacity/.worktrees/test",
    baseBranch: "main",
    status,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("countActiveWip — launch failures do not occupy WIP (#690)", () => {
  it("does NOT count a codex usage-limit (blocked) workspace as active WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);

    // A codex usage-limit launch: workspace persisted as `blocked`, with a stopped
    // launch-failure session carrying the simulated provider failure message + zero diff.
    const wsId = await addWorkspace(db, issueId, "blocked", now);
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3500); // ~3.5s, like the observed failures
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "codex",
      status: "stopped",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "1",
      stats: JSON.stringify({
        rateLimited: true,
        rateLimitKind: "codex-usage-limit",
        retryAfter: "Jun 7th, 2026 1:47 AM",
        failureReason:
          "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Jun 7th, 2026 1:47 AM.",
        launchFailure: true,
        inputTokens: 0,
        outputTokens: 0,
      }),
    });

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });

  it("does NOT count a zero-output (idle) launch failure as active WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);

    const wsId = await addWorkspace(db, issueId, "idle", now);
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(start.getTime() + 500); // <=1s, zero-output
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "claude-code",
      status: "stopped",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      exitCode: "1",
      stats: JSON.stringify({ launchFailure: true, inputTokens: 0, outputTokens: 0 }),
    });

    expect(await countActiveWip(db, inProgressId)).toBe(0);
  });

  it("counts a genuinely active workspace as WIP", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);
    const issueId = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, issueId, "active", now);

    expect(await countActiveWip(db, inProgressId)).toBe(1);
  });

  it("frees capacity: a blocked + an active issue count as 1, not 2", async () => {
    // The observed bug: four blocked workspaces made WIP look full (>=limit) so
    // no new work started. With the fix, only genuinely-active work counts.
    const { db } = createTestDb();
    const { projectId, inProgressId, now } = await seed(db);

    const blockedIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, blockedIssue, "blocked", now);

    const activeIssue = await addIssue(db, projectId, inProgressId, now);
    await addWorkspace(db, activeIssue, "active", now);

    expect(await countActiveWip(db, inProgressId)).toBe(1);
  });
});
