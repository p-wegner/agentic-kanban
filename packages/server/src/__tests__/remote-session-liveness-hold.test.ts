// #744: the completion-state reconciler (and the zombie-fix reconciler) force-stopped
// every RUNNING remote session, because both answered "is this agent alive?" from
// `sessions.pid` — and a session dispatched to a fleet worker has no local pid by
// construction. `agent-remote.service.ts` returns `{}` from launch, so `updateSessionPid`
// never runs; the reconciler read `!pid` as "pid=null (no process was tracked)", marked the
// session stopped and idled the workspace, after which the monitor relaunched the ticket —
// two agents on one branch.
//
// These tests fail on the pre-#744 code for the RIGHT reason: they assert that a session
// stamped with a `workerId` whose worker is connected (or merely unreachable-but-recent) is
// left exactly as it was, which the pid rule cannot do.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileCompletionStates } from "../startup/completion-state-reconciler.js";
import { reconcileZombieFixSessions } from "../startup/zombie-fix-session-reconciler.js";
import {
  classifyRemoteSessionLiveness,
  classifySessionLiveness,
  REMOTE_SESSION_ABANDON_MS,
} from "../services/remote-session-liveness.js";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const NOW = "2026-08-22T12:00:00.000Z";

async function seed(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { workerId?: string | null; pid?: number | null; triggerType?: string; workspaceStatus?: string },
) {
  const ids = {
    projectId: randomUUID(),
    statusId: randomUUID(),
    issueId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
  };
  await db.insert(projects).values({
    id: ids.projectId, name: "T", repoPath: "/tmp/t", repoName: "t", createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(projectStatuses).values({
    id: ids.statusId, projectId: ids.projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: NOW,
  });
  await db.insert(issues).values({
    id: ids.issueId, projectId: ids.projectId, statusId: ids.statusId, title: "t", issueNumber: 1,
    createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(workspaces).values({
    id: ids.workspaceId, issueId: ids.issueId, branch: "feature/ak-1-t",
    status: opts.workspaceStatus ?? "active", workingDir: "/tmp/wt", baseBranch: "main", isDirect: false,
    createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(sessions).values({
    id: ids.sessionId, workspaceId: ids.workspaceId, executor: "claude-code", status: "running",
    startedAt: new Date(Date.parse(NOW) - 10 * 60_000).toISOString(),
    pid: opts.pid ?? null,
    workerId: opts.workerId ?? null,
    triggerType: opts.triggerType,
  });
  return ids;
}

describe("remote session liveness is three-valued (#744)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => { db = createTestDb().db; });

  it("a pid-less session on a CONNECTED worker is left running (not force-stopped)", async () => {
    const { sessionId, workspaceId } = await seed(db, { workerId: "worker-1", pid: null });

    const count = await reconcileCompletionStates(db, {
      now: NOW,
      checkPid: () => false,
      checkCommits: async () => true,
      probeRemote: async () => ({ liveness: "alive", reason: "worker worker-1 is connected" }),
    });

    expect(count).toBe(0);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
    expect(session.endedAt).toBeNull();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(ws.status).toBe("active");
  });

  it("an UNKNOWN verdict holds: the socket is gone but the run is not touched", async () => {
    const { sessionId, workspaceId } = await seed(db, { workerId: "worker-1", pid: null });

    const count = await reconcileCompletionStates(db, {
      now: NOW,
      checkPid: () => false,
      checkCommits: async () => true,
      probeRemote: async () => ({ liveness: "unknown", reason: "worker worker-1 is not connected (silent for 12s)" }),
    });

    expect(count).toBe(0);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(ws.status).toBe("active");
  });

  it("a DEAD verdict (worker revoked) still reconciles — holding is not the same as never giving up", async () => {
    const { sessionId, workspaceId } = await seed(db, { workerId: "worker-1", pid: null });

    const count = await reconcileCompletionStates(db, {
      now: NOW,
      checkPid: () => false,
      checkCommits: async () => true,
      probeRemote: async () => ({ liveness: "dead", reason: "worker worker-1 no longer exists (revoked or deleted)" }),
    });

    expect(count).toBe(1);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(ws.status).toBe("idle");
  });

  it("a HOST session with pid=null is still reconciled — the old rule is intact where it is true", async () => {
    const { sessionId } = await seed(db, { workerId: null, pid: null });

    const count = await reconcileCompletionStates(db, {
      now: NOW,
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");
  });

  it("the zombie-fix reconciler holds a pid-less remote review session instead of reaping it", async () => {
    const { sessionId, workspaceId } = await seed(db, {
      workerId: "worker-1", pid: null, triggerType: "review", workspaceStatus: "reviewing",
    });

    const recovered = await reconcileZombieFixSessions({
      database: db,
      enabled: true,
      nowMs: Date.parse(NOW),
      boardEvents: { broadcast: () => {} } as never,
      probeRemote: async () => ({ liveness: "unknown", reason: "worker worker-1 is not connected (silent for 30s)" }),
    });

    expect(recovered).toBe(0);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(ws.status).toBe("reviewing");
  });
});

describe("classifier: absence of local evidence is not evidence of death", () => {
  const nowMs = Date.parse(NOW);

  it("a remote session with no pid is never 'dead' for want of a pid", () => {
    const verdict = classifySessionLiveness(
      { pid: null, workerId: "w1" },
      {
        checkPid: () => false,
        nowMs,
        remoteEvidence: {
          workerExists: true,
          workerConnected: false,
          lastEvidenceAt: new Date(nowMs - 30_000).toISOString(),
        },
      },
    );
    expect(verdict.liveness).toBe("unknown");
    expect(verdict.reason).toContain("may still be running");
  });

  it("no fleet state at all is the purest unknown — fail HOLD", () => {
    expect(classifySessionLiveness({ pid: null, workerId: "w1" }, { checkPid: () => false }).liveness)
      .toBe("unknown");
  });

  it("a revoked worker is dead; a silent-past-the-bound worker is dead; a connected one is alive", () => {
    const base = { workerExists: true, workerConnected: false, lastEvidenceAt: new Date(nowMs - 60_000).toISOString() };
    expect(classifyRemoteSessionLiveness({ ...base, workerExists: false }, { workerId: "w1", nowMs }).liveness).toBe("dead");
    expect(classifyRemoteSessionLiveness({ ...base, workerConnected: true }, { workerId: "w1", nowMs }).liveness).toBe("alive");
    expect(classifyRemoteSessionLiveness(base, { workerId: "w1", nowMs }).liveness).toBe("unknown");
    expect(
      classifyRemoteSessionLiveness(
        { ...base, lastEvidenceAt: new Date(nowMs - REMOTE_SESSION_ABANDON_MS - 60_000).toISOString() },
        { workerId: "w1", nowMs },
      ).liveness,
    ).toBe("dead");
  });

  it("a host session keeps the pid rule verbatim", () => {
    expect(classifySessionLiveness({ pid: null, workerId: null }, { checkPid: () => false }).liveness).toBe("dead");
    expect(classifySessionLiveness({ pid: 42, workerId: null }, { checkPid: () => true }).liveness).toBe("alive");
    expect(classifySessionLiveness({ pid: 42, workerId: null }, { checkPid: () => false }).liveness).toBe("dead");
    // A throwing probe reads as dead, exactly as isPidAliveCheck did.
    expect(classifySessionLiveness({ pid: 42, workerId: null }, { checkPid: () => { throw new Error("EPERM"); } }).liveness)
      .toBe("dead");
  });
});
