/**
 * #651 — the profile allowlist did not survive a hop to a fleet worker.
 *
 * On the board the allowlist outranks everything: an explicit per-workspace override,
 * the Strategy Bullseye, a workspace's baked-in selection, and a global `claude_profile`
 * the auth-rotation ring rewrote. A worker is a different machine and authenticates the
 * agent with its own local login — correctly, since the board must never send agent
 * credentials (decision 012). But that meant a project pinned to four `andrena_team_5x`
 * subscriptions for billing/tenancy separation would happily spend whatever account the
 * worker machine happened to be logged into, with nothing in the log to say so.
 *
 * The rule these tests pin: a RESTRICTED project does not place remotely at all. It
 * falls back to the board host, which CAN enforce the list — or, for a project that
 * forbids the host fallback, it refuses and says why. An unrestricted project (nearly
 * every project) is untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import { allowedProfilesPrefKey, remoteDispatchBlockedByAllowlist } from "@agentic-kanban/shared/lib/profile-allowlist";
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

const PROJECT_ID = "bbbb1111-2222-3333-4444-555566667777";
const ALLOWED = JSON.stringify([
  { provider: "claude", name: "andrena_team_5x" },
  { provider: "claude", name: "andrena_team_5x_2" },
]);

describe("remoteDispatchBlockedByAllowlist (#651)", () => {
  it("lets an unrestricted project through — that is nearly every project", () => {
    expect(remoteDispatchBlockedByAllowlist(null).blocked).toBe(false);
    expect(remoteDispatchBlockedByAllowlist("").blocked).toBe(false);
    // An explicit empty array is how a restriction is REMOVED without deleting the row.
    expect(remoteDispatchBlockedByAllowlist("[]").blocked).toBe(false);
  });

  it("blocks a restricted project and names the profiles in the reason", () => {
    const verdict = remoteDispatchBlockedByAllowlist(ALLOWED);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error("unreachable");
    expect(verdict.reason).toContain("claude:andrena_team_5x");
    expect(verdict.reason).toContain("claude:andrena_team_5x_2");
    // The reason has to explain WHY the board cannot just send the credential.
    expect(verdict.reason).toMatch(/own machine-local login|no credentials/);
  });

  it("fails closed on a present-but-unreadable allowlist", () => {
    // A botched restriction is still a restriction — reading it as "unrestricted" is
    // exactly the direction that must never happen silently.
    const verdict = remoteDispatchBlockedByAllowlist("[{oops");
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/unreadable/);
  });
});

describe("placement honours the allowlist (#651)", () => {
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
      name: "allowlist-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  it("stays on the host for a restricted project even with an eligible worker waiting", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerLocalWorker();

    const placement = await resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/ak-1",
    });

    // The reason id is the contract (#801): it is what gets persisted on the session row
    // and narrowed back to the vocabulary later, so pin it exactly. The detail is prose in
    // the resolver's own wording and may be reworded — assert only the stable fragment.
    expect(placement).toEqual({
      kind: "host",
      reason: { id: "profile_allowlist" satisfies PlacementReasonId, detail: expect.any(String) },
    });
    expect(placement.reason?.detail).toContain("restricted");
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
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerLocalWorker();

    await expect(
      resolveWorkerPlacement({
        database: db,
        projectId: PROJECT_ID,
        providerName: "claude",
        branch: "feature/ak-1",
      }),
    ).rejects.toThrow(/allowlist|restricted to/);
  });

  it("tells the monitor NOT to start, with the restriction as the reason", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerLocalWorker();

    const verdict = await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" });

    expect(verdict.available).toBe(false);
    if (verdict.available) throw new Error("unreachable");
    // Not "no capacity" — the operator must be able to tell these two apart.
    expect(verdict.reason).toMatch(/restricted to/);
  });
});
