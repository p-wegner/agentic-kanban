// @covers agent-sessions.reattach.recover [state-transition,regression]
//
// Server-restart recovery of detached agent sessions — drives the REAL boot routine
// `cleanupStaleSessions` (startup-tasks.ts:242), not a hand-routed simulation.
//
// On boot the routine walks every DB row still marked "running" and routes each by REAL PID
// liveness (`process.kill(pid, 0)`), not by any mock:
//   - DEAD pid (or pid=null) -> session finalized "stopped" + its workspace reset to "idle"
//                               via the routine's own batched DB updates (startup-tasks.ts:268-274).
//   - LIVE pid               -> sessionManager.reattachSession() restores in-memory context/provider
//                               (the hot-reload SURVIVAL promise) AND agentService.reattachSession()
//                               installs the output watcher + PID poll. The poll's exit callback
//                               mirrors the normal exit path via notifyExternalExit(id, null).
//
// The previously-covered arm is only the dead-PID cleanup; this adds the regression dimension
// (a surviving agent's context is restored from its persisted row so its later exit still routes
// to the workflow — without reattach the agent is silently lost across the restart).
//
// Determinism without spawning processes: route the routine's module-level `db` at a real
// in-memory test DB via vi.mock (the project's standard pattern, e.g. agent-session-resume-
// provider-id.test.ts + startup-tasks.test.ts). PID liveness is REAL: the live session is seeded
// with `process.pid` (this test process — guaranteed alive) and the dead one with a non-existent
// pid, so `process.kill(pid, 0)` actually drives the branch selection.

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

// --- Route the boot routine's module-level db at a REAL in-memory test DB ---------------------
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
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) => database.transaction(fn),
  };
});
// Keep startup-tasks' heavy import graph inert at load (mirrors startup-tasks.test.ts).
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

// Import real units AFTER the mocks are registered.
const { cleanupStaleSessions } = await import("../startup/startup-tasks.js");
const { createSessionState } = await import("../services/session-manager/types.js");
const { createSessionLifecycle } = await import("../services/session-manager/session-lifecycle.js");
const { createMockProc } = await import("./helpers/mocks.js");
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import type { SessionManager } from "../services/session.manager.js";
import type { AgentService } from "../services/session-manager/session-lifecycle.js";
import type * as agentServiceType from "../services/agent.service.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";
import type { TestDb } from "./helpers/test-db.js";

interface Seeded { projectId: string; issueId: string; workspaceId: string; }

async function seedWorkspace(db: TestDb, issueNumber: number): Promise<Seeded> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}`,
    workingDir: `/tmp/repo/.worktrees/ak-${issueNumber}`,
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId };
}

/** Insert a persisted "running" session row (the state that survives in the DB across a restart). */
async function insertRunningSession(db: TestDb, workspaceId: string, pid: number | null, startedAt?: string): Promise<string> {
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "running",
    // A reattached survivor started BEFORE the restart, so its startedAt is old (well outside
    // the 10s launch-failure window) — the realistic shape for the external-exit classifier.
    startedAt: startedAt ?? new Date().toISOString(), pid,
  });
  return sessionId;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

/** Fake agent service for the lifecycle (no real subprocess). */
function lifecycleAgentService(): AgentService {
  return {
    launch: vi.fn(() => createMockProc()),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
}

describe("agent-sessions.reattach.recover — boot routine cleanupStaleSessions", () => {
  it("finalizes dead-PID (and pid=null) sessions to stopped+idle and reattaches the live-PID survivor", async () => {
    const live = await seedWorkspace(h.db, 1);
    const dead = await seedWorkspace(h.db, 2);
    const nullPid = await seedWorkspace(h.db, 3);

    // Persisted "running" rows; a fresh empty SessionState == the post-restart world.
    // The live survivor started well before the restart (old startedAt), so its later external
    // exit lands OUTSIDE the launch-failure window — the realistic reattach shape.
    const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
    const liveSessionId = await insertRunningSession(h.db, live.workspaceId, process.pid, oldStartedAt); // REAL alive PID
    const deadSessionId = await insertRunningSession(h.db, dead.workspaceId, 999_999);     // REAL dead PID
    const nullSessionId = await insertRunningSession(h.db, nullPid.workspaceId, null);     // no PID -> dead

    // Real lifecycle as the session manager (so reattach restores context + the poll's exit
    // callback really finalizes the row), plus a handleOutput stub the routine wires the watcher to.
    const state = createSessionState();
    const onSessionExit = vi.fn();
    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db: h.db, agentService: lifecycleAgentService(), preflight: okPreflight() },
    );
    const handleOutput = vi.fn();
    const sessionManager = { ...lifecycle, handleOutput } as unknown as SessionManager;

    // Capture what the routine installs for the live arm (the output watcher + PID-poll exit cb).
    const reattachCalls: Array<{ sessionId: string; pid: number; onOutput: AgentOutputCallback; onExit: () => void }> = [];
    const agentServiceModule = {
      reattachSession: vi.fn((sessionId: string, pid: number, onOutput: AgentOutputCallback, onExit: () => void) => {
        reattachCalls.push({ sessionId, pid, onOutput, onExit });
      }),
    } as unknown as typeof agentServiceType;

    // --- run the REAL boot routine -------------------------------------------------------------
    await cleanupStaleSessions(sessionManager, agentServiceModule);

    // DEAD arm: both the dead-PID and the pid=null session are stopped, their workspaces idle.
    for (const [sessId, wsId] of [[deadSessionId, dead.workspaceId], [nullSessionId, nullPid.workspaceId]] as const) {
      const [sess] = await h.db.select().from(sessions).where(eq(sessions.id, sessId));
      expect(sess.status).toBe("stopped");
      expect(sess.endedAt).not.toBeNull();
      const [ws] = await h.db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(ws.status).toBe("idle");
    }

    // LIVE arm: the survivor is NOT finalized — its row stays running and its workspace untouched.
    const [liveSess] = await h.db.select().from(sessions).where(eq(sessions.id, liveSessionId));
    expect(liveSess.status).toBe("running");
    const [liveWs] = await h.db.select().from(workspaces).where(eq(workspaces.id, live.workspaceId));
    expect(liveWs.status).toBe("active");

    // LIVE arm (regression: the survival promise): in-memory context + provider restored.
    expect(state.sessionContexts.get(liveSessionId)).toEqual({
      workspaceId: live.workspaceId,
      issueId: live.issueId,
      projectId: live.projectId,
    });
    expect(state.sessionProviders.get(liveSessionId)).toBe("claude-code");

    // LIVE arm: agentService.reattachSession was invoked ONLY for the survivor, with its real PID
    // and the wired output-watcher + exit callbacks (the resumed watcher/poll).
    expect(agentServiceModule.reattachSession).toHaveBeenCalledTimes(1);
    expect(reattachCalls).toHaveLength(1);
    expect(reattachCalls[0].sessionId).toBe(liveSessionId);
    expect(reattachCalls[0].pid).toBe(process.pid);
    // The wired output callback routes into the session manager's handleOutput.
    reattachCalls[0].onOutput({ type: "stdout", data: "tail" } as never);
    expect(handleOutput).toHaveBeenCalledWith(liveSessionId, { type: "stdout", data: "tail" });

    // --- PID-poll-detected exit routes through the exit state machine (contract: exitCode null) ---
    // The poll never observed a real exit code, so this must NOT be recorded as a clean "0"
    // completion (review §3.2). It lands in the explicit INDETERMINATE terminal instead.
    reattachCalls[0].onExit();
    // notifyExternalExit(id, null) is async/fire-and-forget from the poll callback — settle it.
    await vi.waitFor(async () => {
      const [row] = await h.db.select().from(sessions).where(eq(sessions.id, liveSessionId));
      expect(row.endedAt).not.toBeNull();
    });
    const [exitedSess] = await h.db.select().from(sessions).where(eq(sessions.id, liveSessionId));
    // Indeterminate terminal: recognized-terminal "stopped", NOT the old completed/"0" lie.
    expect(exitedSess.status).toBe("stopped");
    expect(exitedSess.status).not.toBe("completed");
    expect(exitedSess.exitCode).toBeNull();
    expect(exitedSess.exitCode).not.toBe("0");
    const indetStats = JSON.parse(exitedSess.stats ?? "{}") as Record<string, unknown>;
    expect(indetStats.indeterminateExit).toBe(true);
    expect(indetStats.success).toBe(false);
    // The workflow callback still receives the raw null exitCode — never a fabricated 0.
    expect(onSessionExit).toHaveBeenCalledTimes(1);
    expect(onSessionExit).toHaveBeenCalledWith(live.workspaceId, liveSessionId, null, false);

    // Idempotency: a second poll-exit (the guard-protected duplicate) is a no-op — finalize ONCE.
    reattachCalls[0].onExit();
    await new Promise((r) => setTimeout(r, 50));
    expect(onSessionExit).toHaveBeenCalledTimes(1);
  });
});

// ── External-exit classification (review §3.2) ────────────────────────────────────────────────
// notifyExternalExit must route through the SAME exit state machine as the live exit path, instead
// of the old raw `String(exitCode ?? 0)` shortcut that recorded EVERY external exit as completed/"0".
describe("notifyExternalExit — routes external exits through the exit state machine", () => {
  /** Build a real lifecycle over the test DB and register the session's context (as reattach does). */
  function makeLifecycle(seeded: Seeded, sessionId: string) {
    const state = createSessionState();
    const onSessionExit = vi.fn();
    const lifecycle = createSessionLifecycle(
      state, { onSessionExit }, vi.fn(),
      { db: h.db, agentService: lifecycleAgentService(), preflight: okPreflight() },
    );
    lifecycle.reattachSession({
      sessionId, workspaceId: seeded.workspaceId, issueId: seeded.issueId,
      projectId: seeded.projectId, providerName: "claude-code",
    });
    return { lifecycle, onSessionExit };
  }

  it("(a) known non-zero exit code is classified as a FAILURE, not recorded as clean '0'", async () => {
    const seeded = await seedWorkspace(h.db, 11);
    // Fresh startedAt (within the launch-failure window) + a real observed non-zero code.
    const sessionId = await insertRunningSession(h.db, seeded.workspaceId, process.pid, new Date().toISOString());
    const { lifecycle, onSessionExit } = makeLifecycle(seeded, sessionId);

    await lifecycle.notifyExternalExit(sessionId, 3);

    const [row] = await h.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.status).not.toBe("completed");   // NOT a clean success
    expect(row.exitCode).toBe("3");             // the real code, never coerced to "0"
    expect(row.exitCode).not.toBe("0");
    const stats = JSON.parse(row.stats ?? "{}") as Record<string, unknown>;
    expect(stats.success).toBe(false);
    expect(stats.launchFailure).toBe(true);
    expect(onSessionExit).toHaveBeenCalledWith(seeded.workspaceId, sessionId, 3, false);
  });

  it("(b) unknown exit code (null) is recorded as the explicit indeterminate state, NOT completed '0'", async () => {
    const seeded = await seedWorkspace(h.db, 12);
    // Old startedAt = a reattached survivor; its PID vanished so the code is unobservable.
    const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
    const sessionId = await insertRunningSession(h.db, seeded.workspaceId, process.pid, oldStartedAt);
    const { lifecycle, onSessionExit } = makeLifecycle(seeded, sessionId);

    await lifecycle.notifyExternalExit(sessionId, null);

    const [row] = await h.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.status).not.toBe("completed");   // the whole point: no fabricated success
    expect(row.status).toBe("stopped");         // recognized indeterminate terminal
    expect(row.exitCode).toBeNull();            // undeterminable — never "0"
    expect(row.exitCode).not.toBe("0");
    const stats = JSON.parse(row.stats ?? "{}") as Record<string, unknown>;
    expect(stats.indeterminateExit).toBe(true);
    expect(stats.success).toBe(false);
    expect(stats.providerExitCode).toBeNull();
    // The workflow callback receives null (undeterminable), never a fabricated 0.
    expect(onSessionExit).toHaveBeenCalledWith(seeded.workspaceId, sessionId, null, false);
  });
});
