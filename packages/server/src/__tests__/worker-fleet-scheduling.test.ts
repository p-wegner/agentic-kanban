// Phase 3 scheduling (#189): label matching, capacity aggregation, strict-mode
// refusal, and the startup incoming-ref recovery sweep.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSContext } from "hono/ws";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
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
import { sweepIncomingWorkerRefs } from "../startup/worker-incoming-sweep.js";
import { incomingRefFor } from "../services/worker-remote-sync.service.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";
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
        .toEqual({ kind: "host" });

      const full = await connectWorker({ name: "full", labels: ["docker", "gpu", "extra"] });
      expect(await selectWorkerForLaunch(fleet, "claude", ["docker", "gpu"])).toBe(full);
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ kind: "remote", workerId: full });
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
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ kind: "remote", workerId });
    });

    it("non-strict projects never block the monitor (host fallback stays legal)", async () => {
      await db.delete(preferences).where(
        // remove the strict flag only
        (await import("drizzle-orm")).eq(preferences.key, workerStrictPrefKey(PROJECT_ID)),
      );
      expect(await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ available: true });
      expect(await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
        .toEqual({ kind: "host" });
    });
  });

  describe("startup incoming-ref sweep", () => {
    let repo: string;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), "sweep-repo-"));
      await gitExecOrThrow(["init", "-b", "master", repo], {});
      await gitExecOrThrow(["config", "user.email", "t@t"], { cwd: repo });
      await gitExecOrThrow(["config", "user.name", "T"], { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "base\n");
      await gitExecOrThrow(["add", "."], { cwd: repo });
      await gitExecOrThrow(["commit", "-m", "base"], { cwd: repo });
      await db.insert(projectsTable).values({
        id: PROJECT_ID, name: "sweep-fixture", repoPath: repo, defaultBranch: "master",
      } as typeof projectsTable.$inferInsert);
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("lands a push that arrived while the board was down", async () => {
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
  });
});
