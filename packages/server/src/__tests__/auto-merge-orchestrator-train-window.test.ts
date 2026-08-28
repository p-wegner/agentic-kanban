import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "AI Reviewed",
    sortOrder: 0,
    isDefault: false,
    createdAt: now,
  });
  return { projectId, statusId };
}

let nextIssueNumber = 1;

async function seedReadyWorkspace(db: ReturnType<typeof createTestDb>["db"], projectId: string, statusId: string) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: nextIssueNumber++,
    title: "Issue",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/${workspaceId}`,
    workingDir: `/tmp/repo/.worktrees/${workspaceId}`,
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

describe("auto-merge orchestrator train batching window (#905)", () => {
  it("holds a single ready workspace back (below default max size, before max wait)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const ws = await seedReadyWorkspace(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    expect(rows.map((r) => r.workspaceId)).toEqual([ws]);

    const nowIso = new Date().toISOString();
    const released = await orchestrator.applyTrainWindow(rows, nowIso);
    expect(released).toEqual([]);
    expect(orchestrator.state.trainWindows.get(projectId)?.pendingIds).toEqual([ws]);
  });

  it("releases as soon as the accumulator reaches train_max_size_<projectId>", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values({
      key: `train_max_size_${projectId}`,
      value: "2",
      updatedAt: new Date().toISOString(),
    });
    invalidatePreferencesCache();

    const ws1 = await seedReadyWorkspace(db, projectId, statusId);
    const ws2 = await seedReadyWorkspace(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());

    expect(released.sort()).toEqual([ws1, ws2].sort());
    expect(orchestrator.state.trainWindows.has(projectId)).toBe(false);
  });

  it("releases once the oldest pending member crosses train_max_wait_ms_<projectId>, even below max size", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "4", updatedAt: new Date().toISOString() },
      { key: `train_max_wait_ms_${projectId}`, value: "60000", updatedAt: new Date().toISOString() },
    ]);
    invalidatePreferencesCache();

    const ws = await seedReadyWorkspace(db, projectId, statusId);
    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();

    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    const stillWaiting = await orchestrator.applyTrainWindow(rows, t0);
    expect(stillWaiting).toEqual([]);

    // 61s later — past the 60s max wait — the same single-member set must release.
    const t1 = new Date(new Date(t0).getTime() + 61_000).toISOString();
    const released = await orchestrator.applyTrainWindow(rows, t1);
    expect(released).toEqual([ws]);
  });

  it("keeps the original firstSeenAt across ticks as new members join the same window", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "3", updatedAt: new Date().toISOString() },
      { key: `train_max_wait_ms_${projectId}`, value: "300000", updatedAt: new Date().toISOString() },
    ]);
    invalidatePreferencesCache();

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const ws1 = await seedReadyWorkspace(db, projectId, statusId);
    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    await orchestrator.applyTrainWindow(await orchestrator.findCompletedWorkspaceRows(), t0);
    expect(orchestrator.state.trainWindows.get(projectId)?.firstSeenAt).toBe(t0);

    // A second member joins two minutes later — firstSeenAt must still be t0, not re-armed.
    await seedReadyWorkspace(db, projectId, statusId);
    const t1 = new Date(new Date(t0).getTime() + 2 * 60_000).toISOString();
    const released = await orchestrator.applyTrainWindow(await orchestrator.findCompletedWorkspaceRows(), t1);
    expect(released).toEqual([]); // still below max size 3, and only 2 min of the 5 min wait elapsed
    expect(orchestrator.state.trainWindows.get(projectId)?.firstSeenAt).toBe(t0);

    // 4 more minutes later (6 min total from t0) — past the 5 min max wait — release with just the 2 pending.
    const t2 = new Date(new Date(t0).getTime() + 6 * 60_000).toISOString();
    const released2 = await orchestrator.applyTrainWindow(await orchestrator.findCompletedWorkspaceRows(), t2);
    expect(released2).toHaveLength(2);
    expect(released2).toContain(ws1);
  });

  it("drops the accumulator for a project whose pending set disappears (healed/parked away)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const ws = await seedReadyWorkspace(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    await orchestrator.applyTrainWindow(await orchestrator.findCompletedWorkspaceRows(), t0);
    expect(orchestrator.state.trainWindows.has(projectId)).toBe(true);

    // The workspace is no longer ready (e.g. closed by a reconcile pass) — the next tick sees
    // an empty rows array and must not keep waiting on a member that no longer exists.
    const released = await orchestrator.applyTrainWindow([], new Date(new Date(t0).getTime() + 1000).toISOString());
    expect(released).toEqual([]);
    expect(orchestrator.state.trainWindows.has(projectId)).toBe(false);
    void ws;
  });

  it("accumulates independently per project", async () => {
    const { db } = createTestDb();
    const { projectId: projectA, statusId: statusA } = await seedProject(db);
    const { projectId: projectB, statusId: statusB } = await seedProject(db);
    await db.insert(preferences).values({
      key: `train_max_size_${projectB}`,
      value: "1",
      updatedAt: new Date().toISOString(),
    });
    invalidatePreferencesCache();

    const wsA = await seedReadyWorkspace(db, projectA, statusA);
    const wsB = await seedReadyWorkspace(db, projectB, statusB);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const released = await orchestrator.applyTrainWindow(await orchestrator.findCompletedWorkspaceRows(), new Date().toISOString());

    // B's max size of 1 releases immediately; A (default max size 4) keeps accumulating.
    expect(released).toEqual([wsB]);
    expect(orchestrator.state.trainWindows.get(projectA)?.pendingIds).toEqual([wsA]);
    expect(orchestrator.state.trainWindows.has(projectB)).toBe(false);
  });
});
