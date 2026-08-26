/**
 * #876 — a project's data-handling requirement (`required_data_labels_<projectId>`, e.g.
 * "no-training") does not survive a hop to a fleet worker, for the same reason the profile
 * allowlist does not (#651): a worker authenticates the agent with its own local login, and
 * the board deliberately sends no credentials (decision 012), so it cannot enforce which
 * account tags apply on that machine.
 *
 * The rule these tests pin, mirroring `worker-allowlist-enforcement.test.ts`: a project with
 * a data-handling requirement does not place remotely at all. It falls back to the board
 * host, which CAN enforce it via `resolveProviderConfig`'s `DATA_HANDLING_REQUIREMENT_HOLD` —
 * or, for a project that forbids the host fallback, it refuses and says why. An unrestricted
 * project (nearly every project) is untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import {
  remoteDispatchBlockedByDataHandling,
  requiredDataLabelsPrefKey,
} from "@agentic-kanban/shared/lib/profile-capabilities";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { PlacementReasonId } from "../lib/placement-explain.types.js";
import type { WSContext } from "hono/ws";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  projectCanDispatch,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";
const REQUIRED = "no-training,eu-data-residency";

describe("remoteDispatchBlockedByDataHandling (#876)", () => {
  it("lets an unrestricted project through — that is nearly every project", () => {
    expect(remoteDispatchBlockedByDataHandling(null).blocked).toBe(false);
    expect(remoteDispatchBlockedByDataHandling("").blocked).toBe(false);
  });

  it("blocks a restricted project and names the tags in the reason", () => {
    const verdict = remoteDispatchBlockedByDataHandling(REQUIRED);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error("unreachable");
    expect(verdict.reason).toContain("no-training");
    expect(verdict.reason).toContain("eu-data-residency");
    // The reason has to explain WHY the board cannot just enforce it remotely.
    expect(verdict.reason).toMatch(/own machine-local login|no credentials/);
  });
});

describe("placement honours the data-handling requirement (#876)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  async function pref(key: string, value: string) {
    await db.insert(preferences).values({ key, value });
  }

  async function registerLocalWorker() {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: "w",
      labels: [SHARES_FILESYSTEM_LABEL],
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, { send: () => {}, close: () => {} } as unknown as WSContext);
    return result.workerId;
  }

  async function seedProject() {
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "data-handling-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  it("stays on the host for a restricted project even with an eligible worker waiting", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(requiredDataLabelsPrefKey(PROJECT_ID), REQUIRED);
    await registerLocalWorker();

    const placement = await resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/ak-1",
    });

    expect(placement).toEqual({
      kind: "host",
      reason: { id: "data_handling_requirement" satisfies PlacementReasonId, detail: expect.any(String) },
    });
    expect(placement.reason?.detail).toContain("no-training");
  });

  it("still dispatches remotely when the project is unrestricted", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await registerLocalWorker();

    const placement = await resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/ak-1",
    });

    expect(placement.kind).toBe("remote");
  });

  it("holds instead of borrowing the host when the project forbids the host fallback", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(requiredDataLabelsPrefKey(PROJECT_ID), REQUIRED);
    await registerLocalWorker();

    await expect(
      resolveWorkerPlacement({
        database: db,
        projectId: PROJECT_ID,
        providerName: "claude",
        branch: "feature/ak-1",
      }),
    ).rejects.toThrow(/data-handling|no-training/);
  });

  it("tells the monitor NOT to start, with the restriction as the reason", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(requiredDataLabelsPrefKey(PROJECT_ID), REQUIRED);
    await registerLocalWorker();

    const verdict = await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" });

    expect(verdict.available).toBe(false);
    if (verdict.available) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/no-training/);
  });
});
