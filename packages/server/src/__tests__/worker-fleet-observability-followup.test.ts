/**
 * #801 — the three fleet-observability gaps #774 left open, each proven rather than promised.
 *
 * The common failure mode all three share: something is COMPUTED and then dropped, so the
 * board looks like it records an answer it does not have. A declared-but-unemitted event
 * type reads to the panel's legend as a thing the board writes; a `fleetHold` nobody renders
 * leaves the operator with a bare `no_available_worker` token; a placement reason nobody
 * persists means "why did that session run on the host" stays unanswerable no matter how
 * good the live explanation gets. These tests assert the wiring exists end to end, because
 * the wiring is precisely what was missing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import { preferences, sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { __resetWorkerSlotReservations } from "../services/worker-slot-reservation.service.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  workerDispatchPrefKey,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { listWorkerEvents } from "../services/worker-events.service.js";
import { listSessionPlacements } from "../services/placement-explain.service.js";
import { updateSessionPlacementReason } from "../repositories/placement-observability.repository.js";
import { buildAutoStartSkipWarnings } from "../services/autodrive-stall-warning.service.js";

const PROJECT_ID = "bbbb1111-2222-3333-4444-555566667777";

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

/** Let the fire-and-forget `void recordWorkerEvent(...)` writes settle before reading. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("#801 — worker event emitters that #774 declared but could not wire", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function registerWorker(name = "w"): Promise<string> {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({ pairingToken, name, protocolVersion: 1 });
    if (!result.ok) throw new Error(result.error);
    return result.workerId;
  }

  it("records the WebSocket lifecycle as connected/disconnected rows", async () => {
    const workerId = await registerWorker();
    const ws = fakeWs();
    fleet.connections.handleOpen(workerId, ws);
    fleet.connections.handleClose(workerId, ws);
    await settle();

    const types = (await listWorkerEvents({ workerId, database: db })).map((e) => e.type);
    // Newest first, and BOTH present — a connect with no matching close is exactly the
    // half-answer that made a #699/#706 flap unreadable from the board side.
    expect(types).toContain("connected");
    expect(types).toContain("disconnected");
    expect(types.indexOf("disconnected")).toBeLessThan(types.indexOf("connected"));
  });

  it("records an effective-status TRANSITION, and only a transition", async () => {
    const workerId = await registerWorker();
    // First sighting seeds silently: after a board restart every worker would otherwise
    // announce a transition from nothing, and "the board rebooted" is not a fact about
    // the worker.
    await fleet.registry.listWorkersView();
    await fleet.registry.listWorkersView();
    await settle();
    expect(await listWorkerEvents({ workerId, types: ["status_change"], database: db })).toHaveLength(0);

    // Now read the fleet far enough in the future that the heartbeat is stale: online -> offline.
    await fleet.registry.listWorkersView(new Date(Date.now() + 10 * 60 * 1000).toISOString());
    await settle();
    const rows = await listWorkerEvents({ workerId, types: ["status_change"], database: db });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ from: "online", to: "offline" });

    // And it does not repeat while the status stays put — a row per heartbeat would spend
    // the whole per-worker retention budget on noise.
    await fleet.registry.listWorkersView(new Date(Date.now() + 11 * 60 * 1000).toISOString());
    await settle();
    expect(await listWorkerEvents({ workerId, types: ["status_change"], database: db })).toHaveLength(1);
  });
});

describe("#801 — fleetHold reaches the operator instead of being dropped", () => {
  it("names the fleet's shape and the drill-down beside the collapsed reason", () => {
    const warnings = buildAutoStartSkipWarnings(
      new Map([
        [
          PROJECT_ID,
          {
            issueNumbers: [42],
            reasonCounts: { no_available_worker: 1 },
            fleetHold: {
              reason: "no fleet worker has free capacity",
              registered: 3,
              online: 2,
              connected: 2,
              eligible: 2,
              freeSlots: 0,
              explain: `/api/workers/explain?projectId=${PROJECT_ID}&issue=<N>`,
            },
          },
        ],
      ]),
      new Map([[PROJECT_ID, "fixture"]]),
      new Date("2026-08-23T00:00:00.000Z"),
    );

    expect(warnings).toHaveLength(1);
    const message = warnings[0]!.message;
    // The token used to render RAW, which told an operator nothing about which of the four
    // causes it was.
    expect(message).toContain("no fleet worker could take the work");
    // The four numbers are what separate "nobody paired" from "paired but not dialled in"
    // from "labels exclude them all" from "simply busy".
    expect(message).toContain("2/3 connected");
    expect(message).toContain("0 free slot(s)");
    expect(message).toContain("/api/workers/explain?projectId=");
  });

  it("says nothing extra when the skip had no fleet hold behind it", () => {
    const warnings = buildAutoStartSkipWarnings(
      new Map([[PROJECT_ID, { issueNumbers: [7], reasonCounts: { wip_cap: 1 } }]]),
      new Map([[PROJECT_ID, "fixture"]]),
      new Date("2026-08-23T00:00:00.000Z"),
    );
    expect(warnings[0]!.message).not.toContain("Fleet:");
  });
});

describe("#801 — the placement reason is recorded AT DISPATCH", () => {
  let db: Database;

  beforeEach(() => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
  });

  it("stamps the deciding check onto the placement the resolver returns", async () => {
    // No opt-in: check 1 decides, and it says so in the resolver's own wording.
    const optedOut = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(optedOut.kind).toBe("host");
    expect(optedOut.reason?.id).toBe("dispatch_opt_in");
    expect(optedOut.reason?.detail).toContain(PROJECT_ID);

    // Opted in with an empty fleet: check 3 decides instead. A re-derivation days later
    // could not tell these two apart — both are simply "host".
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
    const noWorker = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(noWorker.kind).toBe("host");
    expect(noWorker.reason?.id).toBe("eligible_worker");
  });

  it("survives to listSessionPlacements, and an unrecognised id reads as not-recorded", async () => {
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Done", sortOrder: 1 });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-1", worktreePath: "/tmp/p/wt", status: "active",
    });
    await db.insert(sessions).values({ id: sessionId, workspaceId, status: "completed" });

    await updateSessionPlacementReason(
      sessionId,
      { id: "repo_transport_shape", detail: "project has submodules" },
      db,
    );
    const [recorded] = await listSessionPlacements({ database: db, workspaceId });
    expect(recorded?.placementReason).toBe("repo_transport_shape");
    expect(recorded?.placementDetail).toBe("project has submodules");

    // The column is free text to SQLite. A row written by an older build (or hand-edited)
    // must not be able to claim a reason id the vocabulary does not have.
    await updateSessionPlacementReason(sessionId, { id: "not_a_check", detail: "whatever" }, db);
    const [bogus] = await listSessionPlacements({ database: db, workspaceId });
    expect(bogus?.placementReason).toBeNull();
    expect(bogus?.placementDetail).toBeNull();
  });
});
