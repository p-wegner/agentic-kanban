// #1459 — a --resume must follow its conversation. On the worker that holds it: resume. On any
// other worker or the host (holder full/offline): drop --resume and start fresh with a handoff.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";
import {
  preferences, projects as projectsTable, projectStatuses, issues, workspaces, sessions,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { getWorkerFleet, resolveWorkerPlacement, workerDispatchPrefKey, type WorkerFleet } from "../services/worker-fleet.service.js";
import { __resetWorkerSlotReservations, reserveWorkerSlot } from "../services/worker-slot-reservation.service.js";
import { resumeConversationReachable, withResumeHandoff } from "../services/worker-resume-affinity.service.js";
import { resumeReachableFromPlacement } from "../services/session-manager/session-placement.js";

const PROJECT_ID = "bbbb1111-2222-3333-4444-555566667777";
const STATUS_ID = "bbbb2222-2222-3333-4444-555566667777";
const BRANCH = "feature/ak-1459-resume";

describe("#1459 resume follows the conversation", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(async () => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
    await db.insert(projectsTable).values({
      id: PROJECT_ID, name: "resume-fixture", repoPath: "C:/some/repo", defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
    await db.insert(projectStatuses).values({
      id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
    } as typeof projectStatuses.$inferInsert);
  });

  async function seedPriorDispatch(workerId: string): Promise<void> {
    const at = new Date(Date.now() - 60_000).toISOString();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: 1459, title: "prior", statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: at, updatedAt: at,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: BRANCH, baseBranch: "master", status: "active", createdAt: at, updatedAt: at,
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, status: "stopped", startedAt: at, endedAt: at, workerId,
    } as typeof sessions.$inferInsert);
  }

  async function connectWorker(name: string, maxConcurrency: number): Promise<string> {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken, name, maxConcurrency, protocolVersion: 1,
    } as Parameters<WorkerFleet["registry"]["registerWorker"]>[0]);
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, { send: () => {}, close: () => {} } as unknown as WSContext);
    return result.workerId;
  }

  const place = () =>
    resolveWorkerPlacement({
      database: db, projectId: PROJECT_ID, providerName: "claude", branch: BRANCH, baseBranch: "master",
      resumeProviderSessionId: "3c5f0f06-conv",
    });
  const workspace = { isDirect: false, branch: BRANCH };

  it("holder eligible: lands on the holder and the resume is kept", async () => {
    const a = await connectWorker("A", 2);
    await connectWorker("B", 2);
    await seedPriorDispatch(a);
    const placement = await place();
    expect(placement).toMatchObject({ kind: "remote", workerId: a });
    expect(await resumeReachableFromPlacement(db, PROJECT_ID, workspace, placement)).toBe(true);
  });

  it("holder full: placed on B, resume dropped (fresh session with handoff)", async () => {
    const a = await connectWorker("A", 1);
    const b = await connectWorker("B", 2);
    await seedPriorDispatch(a);
    reserveWorkerSlot(a);
    const placement = await place();
    expect(placement).toMatchObject({ kind: "remote", workerId: b });
    expect(await resumeReachableFromPlacement(db, PROJECT_ID, workspace, placement)).toBe(false);
  });

  it("conversation on the host (no worker dispatch recorded): a worker placement drops the resume", async () => {
    await connectWorker("B", 2);
    const placement = await place();
    expect(placement.kind).toBe("remote");
    expect(await resumeReachableFromPlacement(db, PROJECT_ID, workspace, placement)).toBe(false);
  });

  it("pure decision: host holder + host placement keeps; worker holder + host placement drops", () => {
    expect(resumeConversationReachable(null, { kind: "host" })).toBe(true);
    expect(resumeConversationReachable("A", { kind: "host" })).toBe(false);
    expect(resumeConversationReachable("A", { kind: "remote", workerId: "A" })).toBe(true);
    expect(resumeConversationReachable("A", { kind: "remote", workerId: "B" })).toBe(false);
  });

  it("handoff prompt carries the handoff text and the original prompt", () => {
    const p = withResumeHandoff("do the thing", "# HANDOFF\nlast commit abc");
    expect(p).toContain("FRESH session");
    expect(p).toContain("last commit abc");
    expect(p.endsWith("do the thing")).toBe(true);
  });
});
