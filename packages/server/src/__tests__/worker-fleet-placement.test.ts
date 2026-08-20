import { describe, it, expect, beforeEach } from "vitest";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";

const PROJECT_ID = "aaaa1111-2222-3333-4444-555566667777";

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

describe("worker-fleet placement (phase 1c)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function optIn() {
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
  }

  async function registerWorker(overrides?: {
    providers?: string[];
    maxConcurrency?: number;
    name?: string;
    labels?: string[];
  }) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: overrides?.name ?? "w",
      providers: overrides?.providers,
      maxConcurrency: overrides?.maxConcurrency,
      labels: overrides?.labels,
    });
    if (!result.ok) throw new Error(result.error);
    return result.workerId;
  }

  /** A worker that shares the board's filesystem — the phase-1c direct path. */
  const registerLocalWorker = (overrides?: Parameters<typeof registerWorker>[0]) =>
    registerWorker({ ...overrides, labels: [...(overrides?.labels ?? []), SHARES_FILESYSTEM_LABEL] });

  async function seedProject(repoPath = "C:/some/repo") {
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "placement-fixture",
      repoPath,
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  it("defaults to host when the project has not opted in", async () => {
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("falls back to host when opted in but no worker is connected", async () => {
    await optIn();
    await registerWorker(); // registered but never connected a socket
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("places a filesystem-sharing worker without git transport", async () => {
    await optIn();
    const workerId = await registerLocalWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "remote", workerId, strict: false });
  });

  it("gives a TRUE remote worker git transport with the branch and repo", async () => {
    await optIn();
    await seedProject("C:/repos/fixture");
    const workerId = await registerWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({
      database: db, projectId: PROJECT_ID, providerName: "claude",
      branch: "feature/ak-9-x", baseBranch: "master",
    });
    expect(placement).toEqual({
      kind: "remote",
      workerId,
      strict: false,
      repo: {
        projectId: PROJECT_ID,
        repoPath: "C:/repos/fixture",
        branch: "feature/ak-9-x",
        baseBranch: "master",
        setupScript: undefined,
      },
    });
  });

  it("keeps a branchless (direct) workspace on the host for a true remote worker", async () => {
    await optIn();
    await seedProject();
    const workerId = await registerWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("filters by provider", async () => {
    await optIn();
    const codexOnly = await registerLocalWorker({ providers: ["codex"] });
    fleet.connections.handleOpen(codexOnly, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host" });
  });

  it("respects capacity and prefers the least-loaded worker", async () => {
    const busy = await registerLocalWorker({ name: "busy", maxConcurrency: 1 });
    const idle = await registerLocalWorker({ name: "idle", maxConcurrency: 1 });
    fleet.connections.handleOpen(busy, fakeWs());
    fleet.connections.handleOpen(idle, fakeWs());
    // The busy worker announces one running session — at capacity.
    fleet.connections.handleMessage(busy, JSON.stringify({ type: "hello", workerId: busy, runningSessionIds: ["s1"] }));

    expect(await selectWorkerForLaunch(fleet, "claude")).toBe(idle);

    fleet.connections.handleMessage(idle, JSON.stringify({ type: "hello", workerId: idle, runningSessionIds: ["s2"] }));
    expect(await selectWorkerForLaunch(fleet, "claude")).toBeNull();
  });
});
