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
  workerStrictPrefKey,
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

  async function registerWorkerFull(overrides?: {
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
    return result;
  }

  async function registerWorker(overrides?: Parameters<typeof registerWorkerFull>[0]) {
    return (await registerWorkerFull(overrides)).workerId;
  }

  /** A worker that shares the board's filesystem — the phase-1c direct path. */
  const registerLocalWorker = (overrides?: Parameters<typeof registerWorker>[0]) =>
    registerWorker({ ...overrides, labels: [...(overrides?.labels ?? []), SHARES_FILESYSTEM_LABEL] });

  const registerLocalWorkerFull = (overrides?: Parameters<typeof registerWorkerFull>[0]) =>
    registerWorkerFull({ ...overrides, labels: [...(overrides?.labels ?? []), SHARES_FILESYSTEM_LABEL] });

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

  // #910: `--max-concurrency` is a self-declared slot count that cannot tell a 4-core
  // worker from a 64-core one apart. Once both report real headroom, a load tie breaks by
  // headroom instead of registration order — and a thrashing worker is deprioritised, not
  // excluded, so it is still picked when it is the only option.
  describe("headroom-aware selection (#910)", () => {
    async function heartbeatCapacity(
      workerId: string,
      workerToken: string,
      capacity: { freeRamGb: number; spareCores: number; thrashing: "none" | "light" | "heavy" },
    ) {
      const result = await fleet.registry.heartbeat(workerId, workerToken, { capabilities: { capacity } });
      expect(result.ok).toBe(true);
    }

    it("prefers the worker with more reported headroom on an equal-load tie", async () => {
      const low = await registerLocalWorkerFull({ name: "low-ram" });
      const high = await registerLocalWorkerFull({ name: "high-ram" });
      fleet.connections.handleOpen(low.workerId, fakeWs());
      fleet.connections.handleOpen(high.workerId, fakeWs());
      await heartbeatCapacity(low.workerId, low.workerToken, { freeRamGb: 1, spareCores: 1, thrashing: "none" });
      await heartbeatCapacity(high.workerId, high.workerToken, { freeRamGb: 30, spareCores: 12, thrashing: "none" });

      // Both workers are idle (equal load) — headroom alone decides.
      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(high.workerId);
    });

    it("treats an absent capacity report as unknown, not as zero headroom", async () => {
      const unknown = await registerLocalWorkerFull({ name: "no-report" });
      const reporting = await registerLocalWorkerFull({ name: "low-ram" });
      fleet.connections.handleOpen(unknown.workerId, fakeWs());
      fleet.connections.handleOpen(reporting.workerId, fakeWs());
      // Only one worker ever heartbeats capacity; the other stays "unknown".
      await heartbeatCapacity(reporting.workerId, reporting.workerToken, {
        freeRamGb: 0.5, spareCores: 0, thrashing: "none",
      });

      // A worker that reported real headroom is preferred over one whose headroom is
      // unknown, even though the unknown one might in fact have more room — the resolver
      // can only rank what it was told.
      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(reporting.workerId);
    });

    it("deprioritises a thrashing worker but still selects it when it is the only option", async () => {
      const thrashing = await registerLocalWorkerFull({ name: "thrashing" });
      fleet.connections.handleOpen(thrashing.workerId, fakeWs());
      await heartbeatCapacity(thrashing.workerId, thrashing.workerToken, {
        freeRamGb: 40, spareCores: 16, thrashing: "heavy",
      });

      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(thrashing.workerId);
    });

    it("prefers a calm low-headroom worker over a thrashing high-headroom one", async () => {
      const calm = await registerLocalWorkerFull({ name: "calm" });
      const thrashing = await registerLocalWorkerFull({ name: "thrashing" });
      fleet.connections.handleOpen(calm.workerId, fakeWs());
      fleet.connections.handleOpen(thrashing.workerId, fakeWs());
      await heartbeatCapacity(calm.workerId, calm.workerToken, { freeRamGb: 1, spareCores: 1, thrashing: "none" });
      await heartbeatCapacity(thrashing.workerId, thrashing.workerToken, {
        freeRamGb: 40, spareCores: 16, thrashing: "heavy",
      });

      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(calm.workerId);
    });
  });

  /**
   * #938: before this, the host participated ONLY through the binary `hostSaturated` flag —
   * it changed which reason was recorded and never actually competed. So a board with 40GB
   * free handed work to a worker with 1GB free, because the #910 ranking was applied to
   * every machine in the fleet except the one the board runs on.
   */
  describe("host as a ranked candidate (#938)", () => {
    async function heartbeatCapacity(
      workerId: string,
      workerToken: string,
      capacity: { freeRamGb: number; spareCores: number; thrashing: "none" | "light" | "heavy" },
    ) {
      const result = await fleet.registry.heartbeat(workerId, workerToken, { capabilities: { capacity } });
      expect(result.ok).toBe(true);
    }

    /** An opted-in project with one connected, filesystem-sharing worker of known headroom. */
    async function withWorkerReporting(capacity: {
      freeRamGb: number;
      spareCores: number;
      thrashing: "none" | "light" | "heavy";
    }) {
      await optIn();
      const worker = await registerLocalWorkerFull({ name: "w", providers: ["claude"] });
      fleet.connections.handleOpen(worker.workerId, fakeWs());
      await heartbeatCapacity(worker.workerId, worker.workerToken, capacity);
      return worker.workerId;
    }

    it("keeps the work on the host when the host outranks every eligible worker on headroom", async () => {
      await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });

      // Not `eligible_worker`: a worker WAS eligible. The host simply had more room, and a
      // recorded reason saying "no eligible worker" would send an operator after a fleet
      // problem that does not exist.
      expect(placement).toEqual({
        kind: "host",
        reason: { id: "host_has_headroom", detail: expect.stringContaining("outranks") },
      });
    });

    it("names the headroom that decided, so 'why the host' needs no second lookup", async () => {
      await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });
      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });
      expect(placement.reason?.detail).toContain("40.0GB free");
    });

    it("still dispatches remotely when a worker outranks the host", async () => {
      const workerId = await withWorkerReporting({ freeRamGb: 40, spareCores: 16, thrashing: "none" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 1, spareCores: 1, thrashing: "none" },
      });

      expect(placement).toMatchObject({ kind: "remote", workerId });
    });

    // The host is a candidate, NOT a gate: a board with almost nothing free still takes the
    // work when there is no worker to take it instead. That is the pre-#938 fallback, and
    // ranking must not have turned it into a refusal.
    //
    // It must also keep its OLD REASON. A win needs something to have been beaten, and with
    // an empty fleet "the host outranked every worker" is a vacuous claim about an empty
    // set — recording it as a headroom decision would send an operator looking at RAM when
    // the real answer is that no worker was eligible.
    it("falls back to the host as before when no worker is eligible, whatever the host reports", async () => {
      await optIn();
      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 0.2, spareCores: 0, thrashing: "heavy" },
      });
      expect(placement).toEqual({
        kind: "host",
        reason: { id: "eligible_worker", detail: expect.any(String) },
      });
    });

    // A thrashing host is deprioritised the same way a thrashing worker is (#910) — it does
    // not get to win on raw free RAM while it is swapping.
    it("deprioritises a thrashing host against a calm low-headroom worker", async () => {
      const workerId = await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "heavy" },
      });

      expect(placement).toMatchObject({ kind: "remote", workerId });
    });

    // An unmeasured host cannot be ranked. Defaulting it to "unknown headroom" would place
    // it ahead of nothing and behind every reporting worker — a claim the board never made.
    it("leaves behaviour exactly as before when the caller supplies no host capacity", async () => {
      const workerId = await withWorkerReporting({ freeRamGb: 0.1, spareCores: 0, thrashing: "none" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
      });

      expect(placement).toMatchObject({ kind: "remote", workerId });
    });

    // #245's contract: a strict project either finds an eligible worker or gets
    // NO_AVAILABLE_WORKER. It must never be handed the board "because it had more RAM" —
    // that is precisely the host fallback it opted out of.
    it("never ranks the host in for a strict project — it dispatches remotely instead", async () => {
      const workerId = await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });
      await db.insert(preferences).values({ key: workerStrictPrefKey(PROJECT_ID), value: "true" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });

      expect(placement).toMatchObject({ kind: "remote", workerId });
    });

    it("still refuses a strict project with no eligible worker, however much host headroom there is", async () => {
      await optIn();
      await db.insert(preferences).values({ key: workerStrictPrefKey(PROJECT_ID), value: "true" });

      await expect(
        resolveWorkerPlacement({
          database: db, projectId: PROJECT_ID, providerName: "claude",
          hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
        }),
      ).rejects.toThrow(/no eligible claude worker/);
    });

    // The whole opt-in chain is upstream of the ranking: a project with no fleet has nothing
    // to compare the host against, so it must not acquire a new reason id for running where
    // it was always going to run.
    it("records dispatch_opt_in, not a ranking, for a project that never opted in", async () => {
      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });
      expect(placement).toEqual({
        kind: "host",
        reason: { id: "dispatch_opt_in", detail: expect.any(String) },
      });
    });

    // A worker on a pre-#910 build reports NO capacity. Between two workers, "reports
    // headroom" outranks "unknown" — a report is evidence of a newer build. That rule must
    // not extend to the host: the board ALWAYS reports (Tier 0 is unconditional), so it
    // would win every launch against such a worker on a number nobody compared it to.
    it("does not let the host beat a worker that reports no headroom at all", async () => {
      await optIn();
      const worker = await registerLocalWorkerFull({ name: "w", providers: ["claude"] });
      fleet.connections.handleOpen(worker.workerId, fakeWs());
      // Deliberately NO heartbeat: this worker's capacity is undefined.

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });

      expect(placement).toMatchObject({ kind: "remote", workerId: worker.workerId });
    });

    // The sharp end of the case above: 1GB free is BELOW #908's 2GB floor, so this host is
    // saturated. Winning the ranking here would keep the session on a board the same call
    // just declared too tight to take it — inverting #908 rather than extending it.
    it("never lets a saturated host win the ranking over a worker that could run", async () => {
      await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });

      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostSaturated: true,
        hostCapacity: { freeRamGb: 4, spareCores: 8, thrashing: "none" },
      });

      // Remote, and recorded as machine_saturated — the #908 reason, not a headroom win.
      expect(placement).toMatchObject({
        kind: "remote",
        reason: { id: "machine_saturated" },
      });
    });

    // ...but a saturated host is still the last-resort fallback when nothing else can run.
    // Withholding it from the RANKING must not have turned it into a refusal.
    it("still falls back to a saturated host when no worker is eligible", async () => {
      await optIn();
      const placement = await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostSaturated: true,
        hostCapacity: { freeRamGb: 1, spareCores: 0, thrashing: "none" },
      });
      expect(placement).toEqual({
        kind: "host",
        reason: { id: "eligible_worker", detail: expect.any(String) },
      });
    });

    // A host that wins reserves nothing — there is no slot ledger on the board. A leaked
    // reservation is invisible in exactly the way #751 was, so assert the worker is still
    // selectable afterwards rather than trusting the absence of a call.
    it("claims no worker slot when the host wins", async () => {
      const workerId = await withWorkerReporting({ freeRamGb: 1, spareCores: 1, thrashing: "none" });

      await resolveWorkerPlacement({
        database: db, projectId: PROJECT_ID, providerName: "claude",
        hostCapacity: { freeRamGb: 40, spareCores: 16, thrashing: "none" },
      });

      expect(await selectWorkerForLaunch(fleet, "claude")).toBe(workerId);
    });
  });
});
