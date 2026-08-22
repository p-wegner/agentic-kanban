// #750 item 4 — a RESUMED remote session must go back to the worker that holds its state.
//
// Placement was least-loaded-first with no memory: `session-lifecycle.ts` passes
// `--resume <providerSessionId>` and then lets the fleet pick whatever worker is idlest.
// But both halves of a resume live on ONE machine — the provider transcript in that
// worker's `~/.claude`, and the git checkout in its `checkouts/<sessionId>` — so a resume
// that lands elsewhere fails with "no conversation found" and is classified as a launch
// failure. Nothing covered resume on remote placement at all.
//
// Affinity is a PREFERENCE, not a hold: it is applied to the already-filtered candidate
// list, so it can never over-assign a worker whose free slot #751's reservations have
// already claimed. That is the second property here, and it is the one that would make
// affinity a regression if it were wrong.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import {
  preferences,
  projects as projectsTable,
  projectStatuses,
  issues,
  workspaces,
  sessions,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  workerDispatchPrefKey,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import {
  __resetWorkerSlotReservations,
  reserveWorkerSlot,
} from "../services/worker-slot-reservation.service.js";
import { resolveResumeWorkerAffinity } from "../services/worker-resume-affinity.service.js";

const PROJECT_ID = "aaaa1111-2222-3333-4444-555566667777";
const STATUS_ID = "aaaa2222-2222-3333-4444-555566667777";
const BRANCH = "feature/ak-750-affinity";

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

describe("#750 resume affinity — a resumed session prefers the worker holding its checkout", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(async () => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
    await db.insert(projectsTable).values({
      id: PROJECT_ID, name: "affinity-fixture", repoPath: "C:/some/repo", defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
    await db.insert(projectStatuses).values({
      id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
    } as typeof projectStatuses.$inferInsert);
  });

  let nextIssueNumber = 750;

  /** A finished fleet dispatch of `branch` to `workerId` — the state a resume follows. */
  async function seedPriorDispatch(branch: string, workerId: string, startedAt: string): Promise<void> {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: nextIssueNumber++, title: `prior dispatch for ${branch}`,
      statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: startedAt, updatedAt: startedAt,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch, baseBranch: "master", status: "active",
      createdAt: startedAt, updatedAt: startedAt,
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, status: "stopped", startedAt, endedAt: startedAt, workerId,
    } as typeof sessions.$inferInsert);
  }

  async function connectWorker(name: string, maxConcurrency: number): Promise<string> {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken, name, maxConcurrency, protocolVersion: 1,
    } as Parameters<WorkerFleet["registry"]["registerWorker"]>[0]);
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    return result.workerId;
  }

  const place = (resumeProviderSessionId?: string) =>
    resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: BRANCH,
      baseBranch: "master",
      resumeProviderSessionId,
    });

  it("sends a resume back to the previous worker even when another is idler", async () => {
    const held = await connectWorker("holder", 2);
    const idle = await connectWorker("idle", 2);
    await seedPriorDispatch(BRANCH, held, new Date(Date.now() - 60_000).toISOString());
    // The holder is busier, so least-loaded-first — the whole of placement before this —
    // picks the idle worker, which has neither the transcript nor the checkout.
    reserveWorkerSlot(held);

    const placement = await place("provider-session-abc");
    expect(placement.kind).toBe("remote");
    expect(placement.kind === "remote" && placement.workerId).toBe(held);
    expect(idle).not.toBe(held);
  });

  it("never over-assigns: a full holder falls back to another worker, loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const held = await connectWorker("holder", 1);
    const other = await connectWorker("other", 1);
    await seedPriorDispatch(BRANCH, held, new Date(Date.now() - 60_000).toISOString());
    // #751: the holder's only slot is already claimed by a placement in flight. Affinity
    // must respect that reservation — preferring a worker with no free slot would be the
    // double-assignment #751 exists to prevent.
    reserveWorkerSlot(held);

    const placement = await place("provider-session-abc");
    expect(placement.kind === "remote" && placement.workerId).toBe(other);
    // ...and it SAYS so: the resume will very likely fail on a worker that holds neither
    // half of the session's state, and that has to be visible rather than inferred.
    expect(warn.mock.calls.flat().join(" ")).toContain("resume");
    warn.mockRestore();
  });

  it("ignores affinity for a FRESH session (no provider session to resume)", async () => {
    const held = await connectWorker("holder", 2);
    const idle = await connectWorker("idle", 2);
    await seedPriorDispatch(BRANCH, held, new Date(Date.now() - 60_000).toISOString());
    reserveWorkerSlot(held);

    // A fresh start has no transcript anywhere, so the load-balancing choice is correct.
    const placement = await place(undefined);
    expect(placement.kind === "remote" && placement.workerId).toBe(idle);
  });

  it("resolves the NEWEST dispatch of the branch, not just any of them", async () => {
    await seedPriorDispatch(BRANCH, "worker-old", "2026-08-01T10:00:00.000Z");
    await seedPriorDispatch(BRANCH, "worker-new", "2026-08-20T10:00:00.000Z");
    await seedPriorDispatch("feature/ak-999-other", "worker-elsewhere", "2026-08-21T10:00:00.000Z");

    expect(await resolveResumeWorkerAffinity({ projectId: PROJECT_ID, branch: BRANCH }, db))
      .toBe("worker-new");
    expect(await resolveResumeWorkerAffinity({ projectId: PROJECT_ID, branch: "feature/ak-nope" }, db))
      .toBeNull();
  });
});
