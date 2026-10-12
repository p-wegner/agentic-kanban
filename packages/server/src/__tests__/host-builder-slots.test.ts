import { describe, it, expect, beforeEach } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import { __resetWorkerSlotReservations } from "../services/worker-slot-reservation.service.js";
import {
  getWorkerFleet,
  hostBuilderSlotsPrefKey,
  resolveWorkerPlacement,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { hostAtBuilderCap, parseHostBuilderSlots } from "../services/worker-host-candidate.js";

const PROJECT_ID = "aaaa1111-2222-3333-4444-555566667777";
const BIG_HOST = { freeRamGb: 40, spareCores: 16, thrashing: "none" as const };

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

describe("host_builder_slots rule (#1380)", () => {
  it("parses project over global, unset = unlimited, garbage = unset", () => {
    expect(parseHostBuilderSlots(undefined, undefined)).toBeNull();
    expect(parseHostBuilderSlots("", "")).toBeNull();
    expect(parseHostBuilderSlots(undefined, "2")).toBe(2);
    expect(parseHostBuilderSlots("0", "2")).toBe(0);
    expect(parseHostBuilderSlots("abc", "3")).toBe(3);
    expect(parseHostBuilderSlots("-1", undefined)).toBeNull();
  });

  it("is at its cap only when a cap is set and reached", () => {
    expect(hostAtBuilderCap(null, 99)).toBe(false);
    expect(hostAtBuilderCap(0, 0)).toBe(true);
    expect(hostAtBuilderCap(2, 1)).toBe(false);
    expect(hostAtBuilderCap(2, 2)).toBe(true);
  });
});

describe("host_builder_slots placement (#1380)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  const setPref = (key: string, value: string) => db.insert(preferences).values({ key, value });

  /** An opted-in project; a connected worker reporting LESS headroom than the host. */
  async function withOnlineWorker() {
    await setPref(workerDispatchPrefKey(PROJECT_ID), "true");
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken, name: "w", providers: ["claude"], maxConcurrency: 2, labels: [SHARES_FILESYSTEM_LABEL], protocolVersion: 1,
    } as Parameters<WorkerFleet["registry"]["registerWorker"]>[0]);
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    await fleet.registry.heartbeat(result.workerId, result.workerToken, {
      capabilities: { capacity: { freeRamGb: 1, spareCores: 1, thrashing: "none" } },
    });
    return result.workerId;
  }

  const place = (hostActiveSessions: number) =>
    resolveWorkerPlacement({
      database: db, projectId: PROJECT_ID, providerName: "claude",
      hostCapacity: BIG_HOST, hostActiveSessions,
    });

  it("without a cap the roomier host still wins (unchanged)", async () => {
    await withOnlineWorker();
    expect(await place(0)).toMatchObject({ kind: "host", reason: { id: "host_has_headroom" } });
  });

  it("slots=0 sends every launch to the online worker, however roomy the host", async () => {
    const workerId = await withOnlineWorker();
    await setPref("host_builder_slots", "0");
    const first = await place(0);
    expect(first).toMatchObject({ kind: "remote", workerId });
    expect(first.reason?.detail).toContain("host at its builder cap (0/0)");
    // a second ticket: the first's slot is claimed on the worker, but the cap still holds
    expect(await place(0)).toMatchObject({ kind: "remote", workerId });
  });

  it("slots=0 falls back to the host when the worker is offline", async () => {
    await setPref(workerDispatchPrefKey(PROJECT_ID), "true");
    await setPref("host_builder_slots", "0");
    expect(await place(0)).toMatchObject({ kind: "host", reason: { id: "eligible_worker" } });
  });

  it("slots=0 with a strict project refuses rather than building on the host", async () => {
    await setPref(workerDispatchPrefKey(PROJECT_ID), "true");
    await setPref(workerStrictPrefKey(PROJECT_ID), "true");
    await setPref("host_builder_slots", "0");
    await expect(place(0)).rejects.toThrow(/strict/);
  });

  it("slots=2 lets the host win until two sessions run there, then the worker takes over", async () => {
    const workerId = await withOnlineWorker();
    await setPref("host_builder_slots", "2");
    expect(await place(1)).toMatchObject({ kind: "host" });
    expect(await place(2)).toMatchObject({ kind: "remote", workerId });
  });

  it("a per-project value overrides the global one", async () => {
    const workerId = await withOnlineWorker();
    await setPref("host_builder_slots", "5");
    await setPref(hostBuilderSlotsPrefKey(PROJECT_ID), "0");
    expect(await place(0)).toMatchObject({ kind: "remote", workerId });
  });

  it("does not enforce the cap when the caller supplies no session count", async () => {
    await withOnlineWorker();
    await setPref("host_builder_slots", "0");
    const placement = await resolveWorkerPlacement({
      database: db, projectId: PROJECT_ID, providerName: "claude", hostCapacity: BIG_HOST,
    });
    expect(placement).toMatchObject({ kind: "host" });
  });
});
