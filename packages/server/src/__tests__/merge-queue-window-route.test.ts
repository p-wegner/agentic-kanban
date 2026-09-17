import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeQueueRoute } from "../routes/merge-queue.js";
import {
  startAutoMergeOrchestrator,
  stopAutoMergeOrchestrator,
  mergeTrainWindowPref,
} from "../startup/auto-merge-orchestrator.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";

/**
 * #1186 — the departure-board API: `GET /window`, `POST /window/release`, `POST /window/hold`.
 * Exercises the route against a real orchestrator instance (registered via
 * `startAutoMergeOrchestrator` with a long interval so its own periodic tick never fires in
 * these tests) and a real in-memory DB, since the route reads/writes preferences directly.
 */

async function seedProject(db: TestDb) {
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

let nextIssueNumber = 9000;

async function seedReadyWorkspace(db: TestDb, projectId: string, statusId: string, title = "A ticket") {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const issueNumber = nextIssueNumber++;
  await db.insert(issues).values({
    id: issueId,
    issueNumber,
    title,
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
  return { workspaceId, issueNumber };
}

function makeApp(database: TestDb) {
  const app = new Hono();
  app.route("/api/merge-queue", createMergeQueueRoute(database as never, () => ({}) as never));
  return app;
}

describe("merge-queue window route (#1186)", () => {
  afterEach(() => {
    stopAutoMergeOrchestrator();
  });

  it("GET /window requires projectId", async () => {
    const { db } = createTestDb();
    const app = makeApp(db);
    const res = await app.request("/api/merge-queue/window");
    expect(res.status).toBe(400);
  });

  it("GET /window reports an empty window for a project with nothing pending", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });

    const app = makeApp(db);
    const res = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; window: { pending: unknown[]; lastVerdict: unknown } };
    expect(body.ok).toBe(true);
    expect(body.window.pending).toEqual([]);
    expect(body.window.lastVerdict).toBeNull();
  });

  it("GET /window reports pending members with issue number/title/readySince after a tick", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await db.insert(preferences).values({ key: `train_max_size_${projectId}`, value: "3", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
    const { workspaceId, issueNumber } = await seedReadyWorkspace(db, projectId, statusId, "Fix the thing");

    const orchestrator = startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });
    void orchestrator;
    const { getActiveAutoMergeOrchestrator } = await import("../startup/auto-merge-orchestrator.js");
    const now = new Date("2026-08-26T12:00:00.000Z").toISOString();
    await getActiveAutoMergeOrchestrator()!.applyTrainWindow(
      await getActiveAutoMergeOrchestrator()!.findCompletedWorkspaceRows(),
      now,
    );

    const app = makeApp(db);
    const res = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    const body = await res.json() as {
      ok: boolean;
      window: {
        pending: { workspaceId: string; issueNumber: number; title: string; readySince: string }[];
        lastVerdict: { release: boolean; reason: string };
        config: { maxSize: number };
        firstSeenAt: string;
        projectedDepartureAt: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.window.pending).toEqual([{ workspaceId, issueNumber, title: "Fix the thing", readySince: now }]);
    expect(body.window.lastVerdict).toEqual({ release: false, reason: "accumulating" });
    expect(body.window.config.maxSize).toBe(3);
    expect(body.window.firstSeenAt).toBe(now);
    expect(body.window.projectedDepartureAt).not.toBeNull();
  });

  it("GET /window falls back to the persisted pref when no orchestrator is running in this process", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const { workspaceId, issueNumber } = await seedReadyWorkspace(db, projectId, statusId, "Persisted ticket");
    const t0 = new Date("2026-08-26T12:00:00.000Z").toISOString();
    await db.insert(preferences).values({
      key: mergeTrainWindowPref.key(projectId),
      value: JSON.stringify({
        pendingIds: [workspaceId],
        firstSeenAt: t0,
        lastVerdict: { release: false, reason: "max_wait" },
        decidedAt: t0,
      }),
      updatedAt: t0,
    });

    // Deliberately no startAutoMergeOrchestrator() call — this process has no live orchestrator.
    const app = makeApp(db);
    const res = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    const body = await res.json() as {
      window: { pending: { workspaceId: string; issueNumber: number }[]; lastVerdict: { reason: string } };
    };
    expect(body.window.pending).toEqual([{ workspaceId, issueNumber, title: "Persisted ticket", readySince: t0 }]);
    expect(body.window.lastVerdict).toEqual({ release: false, reason: "max_wait" });
  });

  it("POST /window/hold then GET /window reflects the operator hold", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });

    const app = makeApp(db);
    const holdRes = await app.request("/api/merge-queue/window/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, minutes: 10 }),
    });
    expect(holdRes.status).toBe(200);
    const holdBody = await holdRes.json() as { ok: boolean; holdUntil: string };
    expect(holdBody.ok).toBe(true);
    expect(new Date(holdBody.holdUntil).getTime()).toBeGreaterThan(Date.now());

    const windowRes = await app.request(`/api/merge-queue/window?projectId=${projectId}`);
    const windowBody = await windowRes.json() as { window: { holdUntil: string | null } };
    expect(windowBody.window.holdUntil).toBe(holdBody.holdUntil);
  });

  it("POST /window/hold returns 409 when no orchestrator is running in this process", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const app = makeApp(db);
    const res = await app.request("/api/merge-queue/window/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, minutes: 5 }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /window/hold rejects a non-positive minutes value", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });
    const app = makeApp(db);
    const res = await app.request("/api/merge-queue/window/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, minutes: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /window/release on an empty window returns released: []", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });
    const app = makeApp(db);
    const res = await app.request("/api/merge-queue/window/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; released: string[] };
    expect(body.ok).toBe(true);
    expect(body.released).toEqual([]);
  });

  it("POST /window/release returns 400 without projectId", async () => {
    const { db } = createTestDb();
    startAutoMergeOrchestrator({ database: db, intervalMs: 3_600_000 });
    const app = makeApp(db);
    const res = await app.request("/api/merge-queue/window/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
