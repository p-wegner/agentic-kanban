import { describe, it, expect, beforeEach } from "vitest";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import { __resetWorkerSlotReservations } from "../services/worker-slot-reservation.service.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";

const PROJECT_ID = "aaaa1111-2222-3333-4444-555566667777";

/**
 * The fleet grew a protocol handshake, so `registerWorker` refuses a worker that
 * reports no version. Declared through an intersection rather than by importing the
 * new constant: this suite is about placement and should not go red over a field it
 * does not test.
 */
type RegisterWorkerInput = Parameters<WorkerFleet["registry"]["registerWorker"]>[0] & {
  protocolVersion?: number;
};
const SPEAKS_CURRENT_PROTOCOL: Pick<RegisterWorkerInput, "protocolVersion"> = { protocolVersion: 1 };

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

describe("worker-fleet placement (phase 1c)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    // #751's slot ledger is process-wide (the dispatch proxy has no db handle), so a
    // case that leaves a reservation behind would otherwise starve the next one.
    __resetWorkerSlotReservations();
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
      ...SPEAKS_CURRENT_PROTOCOL,
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

  // #801: every placement now carries the check that DECIDED it, so these cases assert
  // WHICH host fallback this is. Three of them used to be the same `{ kind: "host" }` —
  // indistinguishable in a session record, which is the gap #801 closed.
  it("defaults to host when the project has not opted in", async () => {
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host", reason: { id: "dispatch_opt_in", detail: expect.any(String) } });
  });

  it("falls back to host when opted in but no worker is connected", async () => {
    await optIn();
    await registerWorker(); // registered but never connected a socket
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host", reason: { id: "eligible_worker", detail: expect.any(String) } });
  });

  it("places a filesystem-sharing worker without git transport", async () => {
    await optIn();
    const workerId = await registerLocalWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    // #751: a remote placement also carries the capacity slot it claimed, so a
    // concurrent placement cannot be handed the same one.
    expect(placement).toEqual({
      kind: "remote", workerId, strict: false, reservationId: expect.any(String),
      reason: { id: "eligible_worker", detail: expect.stringContaining("shares this filesystem") },
    });
  });

  // #908: the same chain, landing on the same worker, records a DIFFERENT reason when the
  // caller says the host is saturated — a session placed remotely because the host was full
  // must be distinguishable from one placed remotely because that is simply where the work
  // always goes for this project.
  it("records machine_saturated instead of eligible_worker when the caller reports the host is saturated", async () => {
    await optIn();
    const workerId = await registerLocalWorker({ providers: ["claude"] });
    fleet.connections.handleOpen(workerId, fakeWs());
    const placement = await resolveWorkerPlacement({
      database: db, projectId: PROJECT_ID, providerName: "claude", hostSaturated: true,
    });
    expect(placement).toEqual({
      kind: "remote", workerId, strict: false, reservationId: expect.any(String),
      reason: { id: "machine_saturated", detail: expect.stringContaining("host is saturated") },
    });
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
      reservationId: expect.any(String),
      reason: { id: "eligible_worker", detail: expect.stringContaining("git transport") },
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
    expect(placement).toEqual({ kind: "host", reason: { id: "branch_for_transport", detail: expect.any(String) } });
  });

  it("filters by provider", async () => {
    await optIn();
    const codexOnly = await registerLocalWorker({ providers: ["codex"] });
    fleet.connections.handleOpen(codexOnly, fakeWs());
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement).toEqual({ kind: "host", reason: { id: "eligible_worker", detail: expect.any(String) } });
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
