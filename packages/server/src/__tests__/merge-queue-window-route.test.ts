import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import type { MergeTrainWindowResponse } from "@agentic-kanban/shared";
import { createTestDb } from "./helpers/test-db.js";
import { createMergeQueueRoute } from "../routes/merge-queue.js";
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { readTrainWindow, writeTrainWindow } from "../services/merge-train-window-state.js";

vi.mock("../services/merge-queue.service.js", () => ({
  createMergeQueueService: vi.fn(() => ({ computePlan: vi.fn(), executeQueue: vi.fn() })),
}));

vi.mock("../services/workspace-merge.service.js", () => ({
  createWorkspaceMergeService: vi.fn(() => ({})),
}));

const T0 = "2026-08-26T12:00:00.000Z";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now });
  return { projectId, statusId };
}

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"], projectId: string, statusId: string, issueNumber: number, title: string) {
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(issues).values({ id: issueId, issueNumber, title, priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/${workspaceId}`, workingDir: `/tmp/repo/.worktrees/${workspaceId}`, baseBranch: "main",
    isDirect: false, status: "idle", readyForMerge: true, provider: "claude", createdAt: now, updatedAt: "2026-08-26T11:59:00.000Z",
  });
  return workspaceId;
}

function makeApp(db: ReturnType<typeof createTestDb>["db"], broadcast = vi.fn()) {
  const app = new Hono();
  app.route("/api/merge-queue", createMergeQueueRoute(db, () => ({}) as never, {
    boardEvents: { broadcast, broadcastActivity: vi.fn(), broadcastToAllProjects: vi.fn() },
  }));
  return { app, broadcast };
}

describe("merge-queue window routes (#1186)", () => {
  it("GET /window requires projectId", async () => {
    const { db } = createTestDb();
    const { app } = makeApp(db);
    const res = await app.request("/api/merge-queue/window");
    expect(res.status).toBe(400);
  });

  it("GET /window returns window: null when nothing is held", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const { app } = makeApp(db);
    const res = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, window: null });
  });

  it("GET /window projects the persisted record: members with issue number/title, config, verdict, departure, live train", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([
      { key: `train_max_size_${projectId}`, value: "4", updatedAt: T0 },
      { key: `train_max_wait_ms_${projectId}`, value: "600000", updatedAt: T0 },
    ]);
    invalidatePreferencesCache();
    const ws1 = await seedWorkspace(db, projectId, statusId, 41, "First");
    const ws2 = await seedWorkspace(db, projectId, statusId, 42, "Second");
    await writeTrainWindow(projectId, {
      pendingIds: [ws1, ws2, "ws-gone"],
      firstSeenAt: T0,
      lastVerdict: { release: false, reason: "live_train" },
      lastEvaluatedAt: "2026-08-26T12:00:30.000Z",
      heldUntil: "2026-08-26T12:20:00.000Z",
    }, db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train", memberWorkspaceIds: ["x"] }, db);

    const { app } = makeApp(db);
    const res = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as MergeTrainWindowResponse;
    expect(body.ok).toBe(true);
    expect(body.window).toEqual({
      projectId,
      pending: [
        { workspaceId: ws1, issueNumber: 41, issueTitle: "First", readySince: "2026-08-26T11:59:00.000Z" },
        { workspaceId: ws2, issueNumber: 42, issueTitle: "Second", readySince: "2026-08-26T11:59:00.000Z" },
        { workspaceId: "ws-gone", issueNumber: null, issueTitle: null, readySince: null },
      ],
      firstSeenAt: T0,
      config: { maxSize: 4, maxWaitMs: 600000, fromPosture: false, postureLevel: "standard" },
      lastVerdict: { release: false, reason: "live_train" },
      lastEvaluatedAt: "2026-08-26T12:00:30.000Z",
      projectedDepartureAt: "2026-08-26T12:10:00.000Z",
      heldUntil: "2026-08-26T12:20:00.000Z",
      releaseRequestedAt: null,
      liveTrainId: trainId,
    });
  });

  it("GET /window reports projectedDepartureAt null when maxWaitMs is 0", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values([{ key: `train_max_wait_ms_${projectId}`, value: "0", updatedAt: T0 }]);
    invalidatePreferencesCache();
    const ws = await seedWorkspace(db, projectId, statusId, 1, "Only");
    await writeTrainWindow(projectId, { pendingIds: [ws], firstSeenAt: T0, lastVerdict: { release: false, reason: "accumulating" }, lastEvaluatedAt: T0 }, db);
    const { app } = makeApp(db);
    const body = await (await app.request(`/api/merge-queue/window?projectId=${projectId}`)).json() as MergeTrainWindowResponse;
    expect(body.window?.projectedDepartureAt).toBeNull();
    expect(body.window?.liveTrainId).toBeNull();
  });

  it("POST /window/release stamps releaseRequestedAt, logs the operator action and broadcasts", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const ws = await seedWorkspace(db, projectId, statusId, 1, "Only");
    await writeTrainWindow(projectId, { pendingIds: [ws], firstSeenAt: T0, lastVerdict: { release: false, reason: "accumulating" }, lastEvaluatedAt: T0 }, db);
    const { app, broadcast } = makeApp(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await app.request("/api/merge-queue/window/release", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; window: { releaseRequestedAt?: string } };
      expect(body.ok).toBe(true);
      expect(body.window.releaseRequestedAt).toBeTruthy();
      expect(log.mock.calls.some((args) => String(args[0]).startsWith("[merge-queue] window release requested by operator"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect((await readTrainWindow(projectId, db))?.releaseRequestedAt).toBeTruthy();
    expect(broadcast).toHaveBeenCalledWith(projectId, "merge_train_window_changed");
  });

  it("POST /window/release is 409 when the project has no open window", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const { app, broadcast } = makeApp(db);
    const res = await app.request("/api/merge-queue/window/release", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }),
    });
    expect(res.status).toBe(409);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("POST /window/hold sets heldUntil for N minutes and 0 clears it; both log and broadcast", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const ws = await seedWorkspace(db, projectId, statusId, 1, "Only");
    await writeTrainWindow(projectId, { pendingIds: [ws], firstSeenAt: T0, lastVerdict: { release: false, reason: "accumulating" }, lastEvaluatedAt: T0 }, db);
    const { app, broadcast } = makeApp(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const before = Date.now();
      const res = await app.request("/api/merge-queue/window/hold", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, minutes: 10 }),
      });
      expect(res.status).toBe(200);
      const held = (await readTrainWindow(projectId, db))?.heldUntil;
      expect(held).toBeTruthy();
      const heldMs = new Date(held!).getTime();
      expect(heldMs).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5_000);
      expect(heldMs).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
      expect(log.mock.calls.some((args) => String(args[0]).startsWith("[merge-queue] window held by operator"))).toBe(true);

      const cleared = await app.request("/api/merge-queue/window/hold", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, minutes: 0 }),
      });
      expect(cleared.status).toBe(200);
      expect((await readTrainWindow(projectId, db))?.heldUntil).toBeUndefined();
      expect(log.mock.calls.some((args) => String(args[0]).startsWith("[merge-queue] window hold cleared by operator"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("POST /window/hold rejects negative or non-integer minutes and a missing projectId", async () => {
    const { db } = createTestDb();
    const { app } = makeApp(db);
    for (const body of [{ projectId: "p", minutes: -1 }, { projectId: "p", minutes: 1.5 }, { minutes: 5 }, { projectId: "p", minutes: 100000 }]) {
      const res = await app.request("/api/merge-queue/window/hold", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("GET /api/merge-queue/trains/:id (#1195)", () => {
  it("returns the row with parsed evidence and the attempts lifted to the top level", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train", memberWorkspaceIds: ["a", "b"] }, db);
    await updateMergeTrainState(trainId, {
      state: "red",
      gateEvidence: { gateRuns: 2, landed: [], dropped: ["b"], attempts: [{ n: 1 }, { n: 2 }] },
      bisectResult: { culprits: ["b"] },
      finishedAt: T0,
    }, db);

    const { app } = makeApp(db);
    const res = await app.request(`/api/merge-queue/trains/${trainId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; train: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.train.id).toBe(trainId);
    expect(body.train.state).toBe("red");
    expect(body.train.gateEvidence).toMatchObject({ gateRuns: 2, dropped: ["b"] });
    expect(body.train.bisectResult).toEqual({ culprits: ["b"] });
    expect(body.train.attempts).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("answers an empty attempts list for a train with no evidence yet, and 404 for an unknown id", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train", memberWorkspaceIds: ["a"] }, db);

    const { app } = makeApp(db);
    const fresh = await app.request(`/api/merge-queue/trains/${trainId}`);
    expect(fresh.status).toBe(200);
    const body = await fresh.json() as { train: { gateEvidence: unknown; attempts: unknown[] } };
    expect(body.train.gateEvidence).toBeNull();
    expect(body.train.attempts).toEqual([]);

    const missing = await app.request("/api/merge-queue/trains/nope");
    expect(missing.status).toBe(404);
  });
});
