// Phase 3 scheduling (#189): label matching, capacity aggregation, strict-mode
// refusal, and the startup incoming-ref recovery sweep.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSContext } from "hono/ws";
import {
  preferences,
  projects as projectsTable,
  projectStatuses,
  issues,
  workspaces,
  sessions,
} from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  projectCanDispatch,
  resolveFleetCapacity,
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  workerLabelsPrefKey,
  workerStrictPrefKey,
  WorkerDispatchUnavailableError,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { PENDING_ASSIGN_TTL_MS } from "../services/worker-connection.service.js";
import { sweepIncomingWorkerRefs } from "../startup/worker-incoming-sweep.js";
import { incomingRefFor } from "../services/worker-remote-sync.service.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";
const STATUS_ID = "cccc1111-2222-3333-4444-5555666677aa";
const fakeWs = () => ({ send: () => {}, close: () => {} }) as unknown as WSContext;

describe("worker fleet scheduling (phase 3)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function setPref(key: string, value: string) {
    await db.insert(preferences).values({ key, value });
  }

  async function connectWorker(overrides?: { labels?: string[]; maxConcurrency?: number; name?: string; providers?: string[] }) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: overrides?.name ?? "w",
      labels: [...(overrides?.labels ?? []), SHARES_FILESYSTEM_LABEL],
      maxConcurrency: overrides?.maxConcurrency,
      providers: overrides?.providers,
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    return result.workerId;
  }

  describe("label matching", () => {
    it("only places on a worker carrying every required label", async () => {
      await setPref(workerDispatchPrefKey(PROJECT_ID), "true");
      await setPref(workerLabelsPrefKey(PROJECT_ID), "docker, gpu");

      const partial = await connectWorker({ name: "partial", labels: ["docker"] });
      expect(await selectWorkerForLaunch(fleet, "claude", ["docker", "gpu"])).toBeNull();
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ kind: "host", reason: { id: "eligible_worker", detail: expect.any(String) } });

      const full = await connectWorker({ name: "full", labels: ["docker", "gpu", "extra"] });
      expect(await selectWorkerForLaunch(fleet, "claude", ["docker", "gpu"])).toBe(full);
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toMatchObject({ kind: "remote", workerId: full, strict: false });
      expect(partial).not.toBe(full);
    });
  });

  describe("capacity", () => {
    it("aggregates free slots across eligible workers only", async () => {
      const a = await connectWorker({ name: "a", maxConcurrency: 2 });
      await connectWorker({ name: "b", maxConcurrency: 3 });
      await connectWorker({ name: "codex-only", maxConcurrency: 5, providers: ["codex"] });

      expect(await resolveFleetCapacity(fleet, "claude")).toEqual({ eligibleWorkers: 2, freeSlots: 5 });

      fleet.connections.handleMessage(a, JSON.stringify({ type: "hello", workerId: a, runningSessionIds: ["s1", "s2"] }));
      // `a` is now at capacity and drops out entirely.
      expect(await resolveFleetCapacity(fleet, "claude")).toEqual({ eligibleWorkers: 1, freeSlots: 3 });
    });

    it("counts a dispatched-but-silent assignment against capacity (#248)", async () => {
      const workerId = await connectWorker({ name: "solo", maxConcurrency: 1 });
      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(workerId);

      // Dispatch one session and send NO output back — exactly the window a
      // monitor cycle starting three workspaces at once lands in.
      const spec = { command: "node", args: [], env: {}, cwd: "/wt" };
      expect(fleet.connections.send(workerId, { type: "assign", sessionId: "s1", spec })).toBe(true);

      expect(await selectWorkerForLaunch(fleet, "claude")).toBeNull();
      expect(await resolveFleetCapacity(fleet, "claude")).toEqual({ eligibleWorkers: 0, freeSlots: 0 });

      // Its first output turns the pending slot into a running one — still 1 load,
      // not 2 (the pending entry must not double-count).
      fleet.connections.handleMessage(workerId, JSON.stringify({
        type: "event", event: { type: "stdout", sessionId: "s1", data: "working" },
      }));
      expect(fleet.connections.assignedSessionIds(workerId)).toEqual(["s1"]);

      // Exit frees the slot again.
      fleet.connections.handleMessage(workerId, JSON.stringify({
        type: "event", event: { type: "exit", sessionId: "s1", exitCode: 0 },
      }));
      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(workerId);
    });

    it("frees the slot when the worker reports the assignment failed (#248)", async () => {
      const workerId = await connectWorker({ name: "solo-failed", maxConcurrency: 1 });
      const spec = { command: "node", args: [], env: {}, cwd: "/wt" };
      fleet.connections.send(workerId, { type: "assign", sessionId: "s1", spec });
      expect(await selectWorkerForLaunch(fleet, "claude")).toBeNull();

      fleet.connections.handleMessage(workerId, JSON.stringify({
        type: "assign_failed", sessionId: "s1", error: "spawn ENOENT",
      }));
      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(workerId);
    });

    it("expires a pending assignment that never reported anything (#248)", async () => {
      const workerId = await connectWorker({ name: "solo-lost", maxConcurrency: 1 });
      const spec = { command: "node", args: [], env: {}, cwd: "/wt" };
      const t0 = Date.now();
      fleet.connections.send(workerId, { type: "assign", sessionId: "s1", spec }, t0);
      expect(fleet.connections.assignedSessionIds(workerId, t0 + 1000)).toEqual(["s1"]);
      expect(fleet.connections.assignedSessionIds(workerId, t0 + PENDING_ASSIGN_TTL_MS + 1)).toEqual([]);
    });

    it("reconciles pending assignments against a reconnecting worker's hello (#248)", async () => {
      const workerId = await connectWorker({ name: "reconnect", maxConcurrency: 2 });
      const spec = { command: "node", args: [], env: {}, cwd: "/wt" };
      fleet.connections.send(workerId, { type: "assign", sessionId: "s1", spec });
      fleet.connections.send(workerId, { type: "assign", sessionId: "s2", spec });
      expect(fleet.connections.assignedSessionIds(workerId).sort()).toEqual(["s1", "s2"]);

      // The worker says it only ever got s1: the board's guess is superseded.
      fleet.connections.handleMessage(workerId, JSON.stringify({
        type: "hello", workerId, runningSessionIds: ["s1"],
      }));
      expect(fleet.connections.assignedSessionIds(workerId)).toEqual(["s1"]);
    });
  });

  describe("strict mode", () => {
    beforeEach(async () => {
      await setPref(workerDispatchPrefKey(PROJECT_ID), "true");
      await setPref(workerStrictPrefKey(PROJECT_ID), "true");
    });

    it("refuses the host fallback when no worker is available", async () => {
      await expect(resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .rejects.toBeInstanceOf(WorkerDispatchUnavailableError);
      const gate = await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" });
      expect(gate).toMatchObject({ available: false });
    });

    it("allows the start once a worker has capacity", async () => {
      const workerId = await connectWorker();
      expect(await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ available: true });
      // `strict` rides on the placement (#245) so the dispatch proxy can refuse
      // the host fallback later, when the worker may already be gone.
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toMatchObject({ kind: "remote", workerId, strict: true });
    });

    it("carries strict onto a git-transport placement too (#245)", async () => {
      const { pairingToken } = fleet.registry.mintPairingToken();
      const result = await fleet.registry.registerWorker({ pairingToken, name: "true-remote" });
      if (!result.ok) throw new Error(result.error);
      fleet.connections.handleOpen(result.workerId, fakeWs());
      await db.insert(projectsTable).values({
        id: PROJECT_ID, name: "strict-fixture", repoPath: "C:/repos/strict", defaultBranch: "master",
      } as typeof projectsTable.$inferInsert);

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude", branch: "feature/ak-1-x",
      });
      expect(placement).toMatchObject({ kind: "remote", workerId: result.workerId, strict: true });

      // No branch to push back = nothing safe to dispatch; strict forbids the
      // host fallback that used to happen silently here.
      await expect(resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .rejects.toBeInstanceOf(WorkerDispatchUnavailableError);
    });

    it("non-strict projects never block the monitor (host fallback stays legal)", async () => {
      await db.delete(preferences).where(
        // remove the strict flag only
        (await import("drizzle-orm")).eq(preferences.key, workerStrictPrefKey(PROJECT_ID)),
      );
      expect(await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ available: true });
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ kind: "host", reason: { id: "eligible_worker", detail: expect.any(String) } });
    });
  });

  describe("startup incoming-ref sweep", () => {
    let repo: string;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), "sweep-repo-"));
      await gitExecOrThrow(["init", "-b", "master", repo], {});
      writeFileSync(join(repo, "a.txt"), "base\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "base"], { cwd: repo });
      await db.insert(projectsTable).values({
        id: PROJECT_ID, name: "sweep-fixture", repoPath: repo, defaultBranch: "master",
      } as typeof projectsTable.$inferInsert);
      await db.insert(projectStatuses).values({
        id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
      } as typeof projectStatuses.$inferInsert);
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    /**
     * The persisted assignment record the sweep now requires (#246): an issue +
     * workspace on `branch` with a session stamped with a worker id. Without it
     * the incoming ref is an unsolicited push and must be held.
     */
    async function seedWorkerAssignment(branch: string, issueNumber: number): Promise<void> {
      const issueId = randomUUID();
      const workspaceId = randomUUID();
      const now = new Date().toISOString();
      await db.insert(issues).values({
        id: issueId, issueNumber, title: `assignment for ${branch}`,
        statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: now, updatedAt: now,
      } as typeof issues.$inferInsert);
      await db.insert(workspaces).values({
        id: workspaceId, issueId, branch, baseBranch: "master", status: "active",
        createdAt: now, updatedAt: now,
      } as typeof workspaces.$inferInsert);
      await db.insert(sessions).values({
        // `endedAt` matters since #753: a dispatch is landable while running, or for
        // WORKER_RESULT_LANDABLE_AFTER_END_MS after it ENDED. Without it every seeded
        // assignment read as "not current", which held the ref for the wrong reason and
        // made the diverged-branch case below pass without ever testing divergence.
        id: randomUUID(), workspaceId, status: "stopped", startedAt: now, endedAt: now,
        workerId: "worker-1",
      } as typeof sessions.$inferInsert);
    }

    it("lands a push that arrived while the board was down", async () => {
      await seedWorkerAssignment("feature/ak-5-x", 5);
      writeFileSync(join(repo, "b.txt"), "worker work\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "worker work"], { cwd: repo });
      const sha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      await gitExecOrThrow(["update-ref", incomingRefFor("feature/ak-5-x"), sha], { cwd: repo });
      await gitExecOrThrow(["reset", "--hard", "HEAD~1"], { cwd: repo });

      const result = await sweepIncomingWorkerRefs(db);
      expect(result.landed).toEqual(["feature/ak-5-x"]);
      expect(result.held).toEqual([]);
      const landed = await gitExecOrThrow(["rev-parse", "refs/heads/feature/ak-5-x"], { cwd: repo });
      expect(landed.trim()).toBe(sha);
      // The staging ref is cleared, so a second sweep is a no-op.
      expect((await sweepIncomingWorkerRefs(db)).landed).toEqual([]);
    });

    it("holds (never force-lands) a diverged branch", async () => {
      await seedWorkerAssignment("feature/ak-6-y", 6);
      const base = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      writeFileSync(join(repo, "worker.txt"), "worker\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "worker side"], { cwd: repo });
      const workerSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      await gitExecOrThrow(["update-ref", incomingRefFor("feature/ak-6-y"), workerSha], { cwd: repo });
      await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });
      writeFileSync(join(repo, "board.txt"), "board\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "board side"], { cwd: repo });
      const boardSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      await gitExecOrThrow(["update-ref", "refs/heads/feature/ak-6-y", boardSha], { cwd: repo });

      const result = await sweepIncomingWorkerRefs(db);
      expect(result.landed).toEqual([]);
      expect(result.held).toHaveLength(1);
      expect(result.held[0].branch).toBe("feature/ak-6-y");
      const unchanged = await gitExecOrThrow(["rev-parse", "refs/heads/feature/ak-6-y"], { cwd: repo });
      expect(unchanged.trim()).toBe(boardSha);
      // The staging ref survives so the work is still recoverable by hand.
      const incoming = await gitExec(["rev-parse", "--verify", incomingRefFor("feature/ak-6-y")], { cwd: repo });
      expect(incoming.code).toBe(0);
    });

    it("refuses to land an incoming ref with no worker assignment (#246)", async () => {
      // The attack: a token holder pushes a descendant of master to
      // refs/kanban/incoming/master and waits for a board restart. No session
      // was ever dispatched for "master", so nothing may land.
      writeFileSync(join(repo, "evil.txt"), "unreviewed\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "injected"], { cwd: repo });
      const evilSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
      await gitExecOrThrow(["update-ref", incomingRefFor("master"), evilSha], { cwd: repo });
      await gitExecOrThrow(["reset", "--hard", "HEAD~1"], { cwd: repo });
      const masterBefore = (await gitExecOrThrow(["rev-parse", "refs/heads/master"], { cwd: repo })).trim();

      const result = await sweepIncomingWorkerRefs(db);
      expect(result.landed).toEqual([]);
      expect(result.held).toEqual([{ branch: "master", reason: "no current worker assignment for this branch" }]);
      const masterAfter = (await gitExecOrThrow(["rev-parse", "refs/heads/master"], { cwd: repo })).trim();
      expect(masterAfter).toBe(masterBefore);
      // Held, not deleted — a legitimate ref stays recoverable.
      expect((await gitExec(["rev-parse", "--verify", incomingRefFor("master")], { cwd: repo })).code).toBe(0);
    });

    it("does not land a branch assigned in ANOTHER project (#246)", async () => {
      const otherProjectId = "dddd1111-2222-3333-4444-555566667777";
      const otherRepo = mkdtempSync(join(tmpdir(), "sweep-other-"));
      try {
        await db.insert(projectsTable).values({
          id: otherProjectId, name: "other-fixture", repoPath: otherRepo, defaultBranch: "master",
        } as typeof projectsTable.$inferInsert);
        await db.insert(projectStatuses).values({
          id: randomUUID(), projectId: otherProjectId, name: "In Progress", sortOrder: 0,
        } as typeof projectStatuses.$inferInsert);
        // The assignment lives in THIS project; the ref is pushed into it too,
        // but the branch was only ever dispatched for the other project.
        await seedWorkerAssignment("feature/ak-9-elsewhere", 9);

        writeFileSync(join(repo, "c.txt"), "x\n");
        await gitExecOrThrow(["add", "."], { cwd: repo });
        await gitExecOrThrow(["commit", "-m", "work"], { cwd: repo });
        const sha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
        await gitExecOrThrow(["update-ref", incomingRefFor("feature/ak-99-foreign"), sha], { cwd: repo });
        await gitExecOrThrow(["reset", "--hard", "HEAD~1"], { cwd: repo });

        const result = await sweepIncomingWorkerRefs(db);
        expect(result.landed).toEqual([]);
        expect(result.held.map((h) => h.branch)).toEqual(["feature/ak-99-foreign"]);
      } finally {
        rmSync(otherRepo, { recursive: true, force: true });
      }
    });
  });
});
