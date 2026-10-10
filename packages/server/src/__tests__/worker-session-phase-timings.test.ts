/**
 * #1328 — a git-transport session's placement record carries where its wall-clock went.
 * The worker reports fetch/worktree/setup/agent/push on its `exit` event; the board adds the
 * incoming-ref fast-forward (`landMs`) and records the lot on the session's `session_exit` row,
 * which `listSessionPlacements` (behind `worker placements` and its API) reads back.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { parseWorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createRemoteSessionEventRecorder } from "../services/agent-remote-events.js";
import { listSessionPlacements } from "../services/placement-explain.service.js";
import { listWorkerEvents } from "../services/worker-events.service.js";
import { formatPhaseTimings } from "../cli/commands/worker.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("#1328 — per-phase timings on a remote session", () => {
  let db: Database;
  const workerId = "worker-1328";

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
  });

  async function seedSession(): Promise<{ sessionId: string; workspaceId: string }> {
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Done", sortOrder: 1 });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/p/wt", status: "active",
    });
    await db.insert(sessions).values({ id: sessionId, workspaceId, status: "completed" });
    return { sessionId, workspaceId };
  }

  it("carries the phase durations from the exit event to the placement record and the worker events", async () => {
    const { sessionId, workspaceId } = await seedSession();
    const phases = { fetchKind: "fetch" as const, fetchMs: 4200, worktreeMs: 310, setupMs: 61000, agentMs: 492000, pushMs: 2100, landMs: 180 };
    createRemoteSessionEventRecorder(db).noteSessionExit(
      sessionId,
      { workerId, repo: { branch: "feature/ak-1" } },
      0,
      "landed and finalized",
      undefined,
      phases,
    );
    await settle();

    const [record] = await listSessionPlacements({ database: db, workspaceId });
    expect(record?.phases).toEqual(phases);

    // `worker events` keeps them on the row itself.
    const [exit] = await listWorkerEvents({ workerId, types: ["session_exit"], database: db });
    expect(exit?.payload).toMatchObject({ phases });
  });

  it("reads null for a session that recorded no phases (host / older worker)", async () => {
    const { sessionId, workspaceId } = await seedSession();
    createRemoteSessionEventRecorder(db).noteSessionExit(sessionId, { workerId }, 0, "finalized without landing");
    await settle();
    const [record] = await listSessionPlacements({ database: db, workspaceId });
    expect(record?.phases).toBeNull();
  });

  it("parses phases off a worker exit event and drops junk", () => {
    const parsed = parseWorkerToBoardMessage({
      type: "event",
      event: {
        type: "exit",
        sessionId: "s",
        exitCode: 0,
        phases: { fetchKind: "clone", fetchMs: 1500.4, setupMs: -3, agentMs: "x", pushMs: 20, bogus: 1 },
      },
    });
    expect(parsed).toMatchObject({
      type: "event",
      event: { phases: { fetchKind: "clone", fetchMs: 1500, pushMs: 20 } },
    });
    const phases = (parsed as unknown as { event: { phases: Record<string, unknown> } }).event.phases;
    expect(phases).not.toHaveProperty("setupMs");
    expect(phases).not.toHaveProperty("agentMs");
    expect(phases).not.toHaveProperty("bogus");
  });

  it("formats recorded phases only, in pipeline order", () => {
    expect(formatPhaseTimings({ fetchKind: "clone", fetchMs: 4200, agentMs: 492000, landMs: 180 })).toBe(
      "clone 4.2s · agent 492.0s · land 180ms",
    );
  });
});
