// @covers workspaces.lifecycle.remote-session-survives-restart [state-transition, regression]
//
// #745: decision 012 promises a worker's result "will land from the incoming ref on the
// next startup sweep" after a board restart. `cleanupStaleSessions` broke the promise
// before the sweep could keep it: it marked EVERY pid-less `running` session `stopped`
// and idled its workspace — and a remote session has no local pid by construction. The
// worker then reconnected, its `hello` found a terminal row, and the board answered by
// telling it to STOP an agent that had been working.
//
// This drives the REAL boot routine over a mixed fleet, with a real in-memory DB routed
// into the routine's module-level `db`, and asserts the whole-fleet outcome:
//   - REMOTE session (workerId set, pid null, worker row with a fresh heartbeat but no
//     socket — exactly the state one millisecond after a restart) -> stays `running`,
//     workspace stays `active`, and the session is RE-ADOPTED by the remote service so
//     its exit lands through the normal path.
//   - HOST session with pid null -> still finalized `stopped` / workspace `idle`.
//
// Fails on the pre-#745 code for the right reason: the remote row comes back `stopped`.

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: undefined as unknown as import("./helpers/test-db.js").TestDb }));
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const { db } = createTestDb();
  h.db = db;
  return {
    db,
    writeDb: db,
    rawClient: {},
    rawWriteClient: {},
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});
// Keep the heavy startup import graph inert at load (mirrors the fleet-reattach exemplar).
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { projects, projectStatuses, issues, workspaces, sessions, workers } from "@agentic-kanban/shared/schema";
import type { SessionManager } from "../services/session.manager.js";
import type { AgentOutputEvent } from "../services/agent.service.js";
// `worker-fleet.service` declares the field as the narrower `AgentExecutionService`; the
// value it holds is always the remote one. `remote-session-readoption.ts` narrows it the
// same way, so this is the production idiom rather than a test-only escape hatch.
import type { RemoteAgentService } from "../services/agent-remote.service.js";

const { cleanupStaleSessions } = await import("../startup/startup-tasks.js");
const { readoptRemoteSessions } = await import("../startup/remote-session-readoption.js");
const { getWorkerFleet } = await import("../services/worker-fleet.service.js");

const NOW = new Date().toISOString();

function fakeSessionManager() {
  const reattached: string[] = [];
  const exits: Array<{ sessionId: string; exitCode: number | null }> = [];
  const outputs: Array<{ sessionId: string; event: AgentOutputEvent }> = [];
  const sm = {
    reattachSession: (o: { sessionId: string }) => { reattached.push(o.sessionId); },
    handleOutput: (sessionId: string, event: AgentOutputEvent) => { outputs.push({ sessionId, event }); },
    notifyExternalExit: async (sessionId: string, exitCode: number | null) => { exits.push({ sessionId, exitCode }); },
  };
  return { sm, reattached, exits, outputs };
}

async function seedProject(db: typeof h.db) {
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: NOW,
  });
  return { projectId, statusId };
}

async function seedSession(
  db: typeof h.db,
  ctx: { projectId: string; statusId: string },
  n: number,
  opts: { pid: number | null; workerId: string | null },
) {
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber: n, title: "T", priority: "medium", sortOrder: 0,
    statusId: ctx.statusId, projectId: ctx.projectId, createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${n}`, workingDir: `/tmp/repo/.worktrees/ak-${n}`,
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    readyForMerge: false, createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "running",
    startedAt: NOW, pid: opts.pid, workerId: opts.workerId,
  });
  return { issueId, workspaceId, sessionId };
}

describe("a board restart preserves in-flight remote work (#745)", () => {
  it("holds and re-adopts the remote session while still sweeping the host one", async () => {
    const db = h.db;
    const ctx = await seedProject(db);
    // A worker row with a FRESH heartbeat and no live socket — the state immediately
    // after a board restart. The liveness seam calls that `unknown`, and unknown HOLDS.
    await db.insert(workers).values({
      id: "w1", name: "w1", maxConcurrency: 2, status: "online", tokenHash: "x",
      lastHeartbeatAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    const remote = await seedSession(db, ctx, 1, { pid: null, workerId: "w1" });
    const host = await seedSession(db, ctx, 2, { pid: null, workerId: null });

    const { sm, reattached } = fakeSessionManager();
    await cleanupStaleSessions(
      sm as unknown as SessionManager,
      { reattachSession: vi.fn() } as never,
    );

    const [remoteRow] = await db.select().from(sessions).where(eq(sessions.id, remote.sessionId)).limit(1);
    expect(remoteRow.status).toBe("running");
    expect(remoteRow.endedAt).toBeNull();
    const [remoteWs] = await db.select().from(workspaces).where(eq(workspaces.id, remote.workspaceId)).limit(1);
    expect(remoteWs.status).toBe("active");

    // Re-adopted, not merely skipped: the remote service tracks it again, so the
    // worker's next event and its exit land through the normal path.
    expect(reattached).toContain(remote.sessionId);
    expect((getWorkerFleet(db as never).remoteAgentService as RemoteAgentService).trackedSessionIds()).toContain(remote.sessionId);

    // The host half of the sweep is untouched.
    const [hostRow] = await db.select().from(sessions).where(eq(sessions.id, host.sessionId)).limit(1);
    expect(hostRow.status).toBe("stopped");
    const [hostWs] = await db.select().from(workspaces).where(eq(workspaces.id, host.workspaceId)).limit(1);
    expect(hostWs.status).toBe("idle");
  });

  it("finalizes a remote session whose worker is provably gone, and names the reason", async () => {
    const db = h.db;
    const ctx = await seedProject(db);
    const s = await seedSession(db, ctx, 3, { pid: null, workerId: "revoked-worker" });
    const { sm } = fakeSessionManager();

    const res = await readoptRemoteSessions({
      database: db as never,
      sessionManager: sm,
      remoteService: { adoptSession: vi.fn() } as never,
      // No `workers` row for this id — the real probe would say exactly this.
      probe: async () => ({ liveness: "dead", reason: "worker revoked-worker no longer exists (revoked or deleted)" }),
    });

    // The mocked db is shared across the cases in this file, so assert on THIS session.
    expect(res.finalized).toContain(s.sessionId);
    expect(res.adopted).not.toContain(s.sessionId);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId)).limit(1);
    expect(row.status).toBe("stopped");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId)).limit(1);
    expect(ws.status).toBe("idle");
  });

  it("the rebuilt callback finalizes the session when the worker's exit finally arrives", async () => {
    const db = h.db;
    const ctx = await seedProject(db);
    const s = await seedSession(db, ctx, 4, { pid: null, workerId: "w-late" });
    const { sm, exits, outputs } = fakeSessionManager();
    let adopted: { onOutput: (e: AgentOutputEvent) => void; repo?: { branch: string } } | undefined;

    await readoptRemoteSessions({
      database: db as never,
      sessionManager: sm,
      remoteService: { adoptSession: (p: never) => { adopted = p; } } as never,
      probe: async () => ({ liveness: "unknown", reason: "worker w-late is not connected (silent for 3s)" }),
      sharesFilesystem: async () => false,
    });

    expect(adopted).toBeDefined();
    // A git-transport session: the adopted mapping carries the branch, so the exit
    // lands the pushed result through the #743 path rather than orphaning it.
    expect(adopted?.repo?.branch).toBe("feature/ak-4");

    adopted?.onOutput({ type: "stdout", sessionId: s.sessionId, data: "back on the air" });
    adopted?.onOutput({ type: "exit", sessionId: s.sessionId, exitCode: 0 });

    expect(outputs.map((o) => o.event.type)).toEqual(["stdout", "exit"]);
    expect(exits).toEqual([{ sessionId: s.sessionId, exitCode: 0 }]);
  });

  it("a same-filesystem worker's session is adopted WITHOUT a landing step", async () => {
    const db = h.db;
    const ctx = await seedProject(db);
    await seedSession(db, ctx, 5, { pid: null, workerId: "w-local" });
    const { sm } = fakeSessionManager();
    let adopted: { repo?: unknown } | undefined;

    await readoptRemoteSessions({
      database: db as never,
      sessionManager: sm,
      remoteService: { adoptSession: (p: never) => { adopted = p; } } as never,
      probe: async () => ({ liveness: "alive", reason: "worker w-local is connected" }),
      sharesFilesystem: async () => true,
    });

    // There is no incoming ref for a worker that shares the filesystem — attempting to
    // land one would report a phantom failure and downgrade a clean exit.
    expect(adopted?.repo).toBeUndefined();
  });
});
