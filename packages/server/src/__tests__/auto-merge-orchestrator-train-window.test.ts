import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { runUnderVerifyChainSemaphore } from "../services/verify-chain-semaphore.js";
import { holdTrainWindow, readTrainWindow, requestTrainWindowRelease } from "../services/merge-train-window-state.js";

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

  describe("gate-busy hold (#1138)", () => {
    // Reproduces the livelock: a project on `train_max_size_<id>=1` (e.g. `iterate`/`standard`
    // posture) sees a lone ready workspace and would normally release it instantly. If a verify
    // chain is already running on the box, releasing straight into it wastes the run — the
    // in-flight gate finishes later, discovers the base moved (#243), and its own verdict is
    // discarded. `applyTrainWindow` must hold the release while `verifyChainSemaphoreActive()`
    // is nonzero, exactly as it already holds below max_size/before max_wait.

    it("holds a max-size-1 release while a verify chain is active", async () => {
      const { db } = createTestDb();
      const { projectId, statusId } = await seedProject(db);
      await db.insert(preferences).values({
        key: `train_max_size_${projectId}`,
        value: "1",
        updatedAt: new Date().toISOString(),
      });
      invalidatePreferencesCache();
      const ws = await seedReadyWorkspace(db, projectId, statusId);

      const orchestrator = createAutoMergeOrchestrator({ database: db });
      const rows = await orchestrator.findCompletedWorkspaceRows();

      let releasedWhileBusy: string[] | undefined;
      await runUnderVerifyChainSemaphore(async () => {
        releasedWhileBusy = await orchestrator.applyTrainWindow(rows, new Date().toISOString());
      });

      expect(releasedWhileBusy).toEqual([]);
      expect(orchestrator.state.trainWindows.get(projectId)?.pendingIds).toEqual([ws]);
    });

    it("releases a max-size-1 batch immediately once the verify chain finishes (no artificial hold on an idle box)", async () => {
      const { db } = createTestDb();
      const { projectId, statusId } = await seedProject(db);
      await db.insert(preferences).values({
        key: `train_max_size_${projectId}`,
        value: "1",
        updatedAt: new Date().toISOString(),
      });
      invalidatePreferencesCache();
      const ws = await seedReadyWorkspace(db, projectId, statusId);

      const orchestrator = createAutoMergeOrchestrator({ database: db });
      const rows = await orchestrator.findCompletedWorkspaceRows();

      // No verify chain running — must release exactly as before (#905's original behaviour).
      const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());
      expect(released).toEqual([ws]);
    });
  });
});

describe("auto-merge orchestrator train window persistence (#1186)", () => {
  it("persists the window as train_window_<projectId> and restores firstSeenAt across a restart", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "4", updatedAt: new Date().toISOString() },
      { key: `train_max_wait_ms_${projectId}`, value: "60000", updatedAt: new Date().toISOString() },
    ]);
    invalidatePreferencesCache();
    const ws = await seedReadyWorkspace(db, projectId, statusId);

    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    const first = createAutoMergeOrchestrator({ database: db });
    const rows = await first.findCompletedWorkspaceRows();
    expect(await first.applyTrainWindow(rows, t0)).toEqual([]);

    const persisted = await readTrainWindow(projectId, db);
    expect(persisted).toMatchObject({
      pendingIds: [ws],
      firstSeenAt: t0,
      lastVerdict: { release: false, reason: "accumulating" },
      lastEvaluatedAt: t0,
    });

    // "Restart": a fresh orchestrator with an empty in-memory map. 30 s later the wait clock
    // must still run from t0, not from the restart — so at t0+61 s it releases on max_wait.
    const second = createAutoMergeOrchestrator({ database: db });
    const t1 = new Date(new Date(t0).getTime() + 30_000).toISOString();
    expect(await second.applyTrainWindow(rows, t1)).toEqual([]);
    expect(second.state.trainWindows.get(projectId)?.firstSeenAt).toBe(t0);

    const t2 = new Date(new Date(t0).getTime() + 61_000).toISOString();
    expect(await second.applyTrainWindow(rows, t2)).toEqual([ws]);
    expect(await readTrainWindow(projectId, db)).toBeNull();
  });

  it("broadcasts merge_train_window_changed only when the window changes, and on release", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "2", updatedAt: new Date().toISOString() },
    ]);
    invalidatePreferencesCache();
    const ws1 = await seedReadyWorkspace(db, projectId, statusId);

    const broadcast = vi.fn();
    const orchestrator = createAutoMergeOrchestrator({
      database: db,
      boardEvents: { broadcast, broadcastActivity: vi.fn(), broadcastToAllProjects: vi.fn() },
    });
    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    let rows = await orchestrator.findCompletedWorkspaceRows();
    await orchestrator.applyTrainWindow(rows, t0);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(projectId, "merge_train_window_changed");

    // Same members, same verdict one tick later: no write, no broadcast.
    await orchestrator.applyTrainWindow(rows, new Date(new Date(t0).getTime() + 30_000).toISOString());
    expect(broadcast).toHaveBeenCalledTimes(1);

    // A second member joins: change → broadcast; and it reaches max size → release → broadcast.
    const ws2 = await seedReadyWorkspace(db, projectId, statusId);
    rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date(new Date(t0).getTime() + 60_000).toISOString());
    expect(released.sort()).toEqual([ws1, ws2].sort());
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("honours an operator release request written to the pref: departs on the next tick with operator_release", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const ws = await seedReadyWorkspace(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    expect(await orchestrator.applyTrainWindow(rows, t0)).toEqual([]);

    const t1 = new Date(new Date(t0).getTime() + 30_000).toISOString();
    expect(await requestTrainWindowRelease(projectId, db, t1)).not.toBeNull();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await orchestrator.applyTrainWindow(rows, new Date(new Date(t0).getTime() + 60_000).toISOString())).toEqual([ws]);
      expect(log.mock.calls.some((args) => String(args[0]).includes("operator_release"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(await readTrainWindow(projectId, db)).toBeNull();
  });

  it("honours an operator hold written to the pref: does not release before heldUntil even at max size, then does", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "1", updatedAt: new Date().toISOString() },
    ]);
    invalidatePreferencesCache();

    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    // Hold placed BEFORE anything is ready — a control-only record.
    await holdTrainWindow(projectId, 5, db, t0);
    const ws = await seedReadyWorkspace(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const t1 = new Date(new Date(t0).getTime() + 60_000).toISOString();
    expect(await orchestrator.applyTrainWindow(rows, t1)).toEqual([]);
    const held = await readTrainWindow(projectId, db);
    expect(held).toMatchObject({ pendingIds: [ws], lastVerdict: { release: false, reason: "held" } });
    // The placeholder's firstSeenAt must not have started the clock: it is the arrival tick.
    expect(held?.firstSeenAt).toBe(t1);

    const t2 = new Date(new Date(t0).getTime() + 6 * 60_000).toISOString();
    expect(await orchestrator.applyTrainWindow(rows, t2)).toEqual([ws]);
  });
});
