// @covers workspaces.lifecycle.reattach-survives-reload [state-transition, regression]
//
// FLEET-level survival across a server restart / hot-reload. The single-session test
// `agent-sessions.reattach.recover` (agent-sessions-reattach-recover.test.ts) already drives
// `cleanupStaleSessions` with one live + one dead + one null PID. What it does NOT touch — and
// what makes the fleet guarantee distinct — is the SECOND boot routine that runs in the same
// reattach/reconcile pass: `reconcileAncestorBranchWorkspaces`. The prior reaper regression
// (memory: "Ancestor reconciler reaps fresh ws — marks 0-commit ws Done") was that a fresh /
// zero-commit workspace got wrongly finalized to Done during this very pass. So this test drives
// the REAL boot routines together over a mixed fleet of workspaces and asserts the whole-fleet
// outcome:
//   - LIVE-PID workspace      -> session stays running, workspace stays "active" (NOT reaped)
//   - DEAD-PID workspace      -> session finalized "stopped", workspace reset to "idle"
//   - FRESH 0-commit workspace -> NOT wrongly closed/marked-Done by the ancestor reconciler
//                                 (the 0-commit guard, ancestor-branch-reconciler.ts:136-141)
//
// Real-boot-routine approach (mirrors the exemplar): route the routines' module-level `db` at a
// real in-memory test DB via vi.mock, and use REAL PID liveness — `process.pid` (this test
// process, guaranteed alive) for the survivor and a never-used PID (999999) for the dead one, so
// `process.kill(pid, 0)` actually selects the branch. Git is injected into the ancestor reconciler
// via its `deps` seam (so the fresh workspace deterministically reports isAncestor=true / 0 unique
// commits without a real repo).

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

// --- Route the boot routines' module-level db at a REAL in-memory test DB --------------------
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
// Keep the heavy startup import graph inert at load (mirrors startup-tasks.test.ts / exemplar).
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

// Import the real units AFTER the mocks are registered.
const { cleanupStaleSessions } = await import("../startup/startup-tasks.js");
const { reconcileAncestorBranchWorkspaces } = await import("../startup/ancestor-branch-reconciler.js");
const { createSessionState } = await import("../services/session-manager/types.js");
const { createSessionLifecycle } = await import("../services/session-manager/session-lifecycle.js");
const { createMockProc } = await import("./helpers/mocks.js");
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import type { SessionManager } from "../services/session.manager.js";
import type { AgentService } from "../services/session-manager/session-lifecycle.js";
import type * as agentServiceType from "../services/agent.service.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";
import type { checkBranchTipIsAncestor, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import type { TestDb } from "./helpers/test-db.js";

interface Seeded { projectId: string; issueId: string; workspaceId: string; branch: string; }

const REPO = "/tmp/repo";

/** One shared project with the three status columns the fleet uses. */
async function seedProject(db: TestDb): Promise<{ projectId: string; statusIds: Record<string, string> }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: REPO, repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusIds: Record<string, string> = {};
  const names = ["In Progress", "In Review", "Done"];
  for (let i = 0; i < names.length; i++) {
    const id = randomUUID();
    statusIds[names[i]] = id;
    await db.insert(projectStatuses).values({
      id, projectId, name: names[i], sortOrder: i, isDefault: i === 0, createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function seedWorkspace(
  db: TestDb,
  projectId: string,
  statusId: string,
  issueNumber: number,
  wsStatus: string,
): Promise<Seeded> {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const branch = `feature/ak-${issueNumber}`;
  await db.insert(issues).values({
    id: issueId, issueNumber, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch,
    workingDir: `${REPO}/.worktrees/ak-${issueNumber}`,
    baseBranch: "main", isDirect: false, status: wsStatus, provider: "claude",
    readyForMerge: false, createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId, branch };
}

/** Insert a persisted "running" session row (the state that survives in the DB across a restart). */
async function insertRunningSession(db: TestDb, workspaceId: string, pid: number | null): Promise<string> {
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "running",
    startedAt: new Date().toISOString(), pid,
  });
  return sessionId;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

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

describe("workspaces.lifecycle.reattach-survives-reload — whole-fleet boot reattach/reconcile", () => {
  it("reattaches the live survivor, idles the dead one, skips fresh 0-commit ws, yet still reconciles a real merged ws", async () => {
    const { projectId, statusIds } = await seedProject(h.db);

    // The mixed fleet, as it sits in the DB the instant the server restarts.
    const live = await seedWorkspace(h.db, projectId, statusIds["In Progress"], 1, "active");
    // INTERACTION case (fix #2): a dead-PID session whose issue is "In Review". cleanupStaleSessions
    // resets its workspace to idle; in the SAME boot pass it then becomes a full ancestor-reconciler
    // candidate (In Review skips the line-115 In-Progress/readyForMerge gate). Its branch is an
    // ancestor with 0 unique commits, so the 0-commit guard must keep it from being reaped — the two
    // routines must produce ONE correct terminal state (idle, not Done). No existing suite runs a
    // single row through BOTH boot routines in one pass.
    const dead = await seedWorkspace(h.db, projectId, statusIds["In Review"], 2, "active");
    // A fresh workspace: branch tip happens to be an ancestor of base, but it carries ZERO unique
    // commits (no real merged work). The prior reaper regression wrongly finalized exactly this.
    const fresh = await seedWorkspace(h.db, projectId, statusIds["In Review"], 3, "idle");
    // A genuinely-merged ws (fix #1): ancestor AND >0 unique commits. Proves the reconciler is NOT
    // globally inert — the 0-commit skip is SELECTIVE, so reconciledCount===1 is a meaningful signal,
    // not the same value a neutered reconciler would return.
    const recon = await seedWorkspace(h.db, projectId, statusIds["In Review"], 4, "idle");

    const liveSessionId = await insertRunningSession(h.db, live.workspaceId, process.pid); // REAL alive
    const deadSessionId = await insertRunningSession(h.db, dead.workspaceId, 999_999);      // REAL dead

    // Real lifecycle as the session manager so reattach restores in-memory context/provider.
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

    const reattachCalls: Array<{ sessionId: string; pid: number; onOutput: AgentOutputCallback; onExit: () => void }> = [];
    const agentServiceModule = {
      reattachSession: vi.fn((sessionId: string, pid: number, onOutput: AgentOutputCallback, onExit: () => void) => {
        reattachCalls.push({ sessionId, pid, onOutput, onExit });
      }),
    } as unknown as typeof agentServiceType;

    // Injected git seam for the ancestor reconciler. dead/fresh/recon branches are all ancestors of
    // base; only `recon` carries unique commits. `live` is not an ancestor (defence in depth — it is
    // also gated out by the In-Progress/active filter). Each ancestor gets a distinct branchSha so
    // countCommits can key the unique-commit count per branch.
    const ANCESTORS = new Set([dead.branch, fresh.branch, recon.branch]);
    const checkAncestor = vi.fn(async (_repo: string, branch: string) =>
      ANCESTORS.has(branch)
        ? { isAncestor: true, branchSha: `sha-${branch}`, baseSha: "sha-base" }
        : { isAncestor: false, branchSha: `sha-${branch}`, baseSha: "sha-base" },
    ) as unknown as typeof checkBranchTipIsAncestor;
    // Only the recon branch has real merged work; dead + fresh have 0 unique commits.
    const countCommits = vi.fn(async (_repo: string, _baseSha: string, branchSha: string) =>
      branchSha === `sha-${recon.branch}` ? 2 : 0,
    ) as unknown as typeof countUniqueCommits;

    // --- drive the REAL boot reattach/reconcile pass, in boot order --------------------------
    await cleanupStaleSessions(sessionManager, agentServiceModule);
    const reconciledCount = await reconcileAncestorBranchWorkspaces({
      database: h.db,
      checkAncestor,
      countCommits,
      enabled: true,
    });

    // DEAD / INTERACTION arm: routine 1 (cleanupStaleSessions) stops the session + idles the ws;
    // routine 2 (ancestor reconciler) then SEES the now-idle In-Review ws as a candidate but the
    // 0-commit guard keeps it from being reaped. Single correct terminal state, no double-handling:
    // session stopped, workspace idle (NOT closed), mergedAt null, issue still In Review.
    const [deadSess] = await h.db.select().from(sessions).where(eq(sessions.id, deadSessionId));
    expect(deadSess.status).toBe("stopped");
    expect(deadSess.endedAt).not.toBeNull();
    const [deadWs] = await h.db.select().from(workspaces).where(eq(workspaces.id, dead.workspaceId));
    expect(deadWs.status).toBe("idle");
    expect(deadWs.mergedAt).toBeNull();
    const [deadIssue] = await h.db.select().from(issues).where(eq(issues.id, dead.issueId));
    expect(deadIssue.statusId).toBe(statusIds["In Review"]); // NOT reaped to Done by routine 2

    // LIVE arm: survivor NOT reaped — row stays running, workspace stays active, context restored.
    const [liveSess] = await h.db.select().from(sessions).where(eq(sessions.id, liveSessionId));
    expect(liveSess.status).toBe("running");
    const [liveWs] = await h.db.select().from(workspaces).where(eq(workspaces.id, live.workspaceId));
    expect(liveWs.status).toBe("active");
    expect(state.sessionContexts.get(liveSessionId)).toEqual({
      workspaceId: live.workspaceId,
      issueId: live.issueId,
      projectId: live.projectId,
    });
    expect(agentServiceModule.reattachSession).toHaveBeenCalledTimes(1);
    expect(reattachCalls).toHaveLength(1);
    expect(reattachCalls[0].sessionId).toBe(liveSessionId);
    expect(reattachCalls[0].pid).toBe(process.pid);

    // FRESH/0-commit arm (the reaper regression guard): the reconciler considered it (isAncestor)
    // but skipped it on the 0-commit guard — it is NOT closed and its issue is NOT moved to Done.
    expect(checkAncestor).toHaveBeenCalled();
    const [freshWs] = await h.db.select().from(workspaces).where(eq(workspaces.id, fresh.workspaceId));
    expect(freshWs.status).not.toBe("closed");
    expect(freshWs.mergedAt).toBeNull();
    const [freshIssue] = await h.db.select().from(issues).where(eq(issues.id, fresh.issueId));
    expect(freshIssue.statusId).toBe(statusIds["In Review"]); // still In Review, NOT Done

    // RECON arm (fix #1 — proves the skip is SELECTIVE, not a globally-inert reconciler): the one ws
    // with real merged work (ancestor + 2 unique commits) IS reconciled — closed, mergedAt set, issue
    // moved to Done. Exactly ONE workspace reconciled, so reconciledCount===0/!==0 carries real signal.
    expect(reconciledCount).toBe(1);
    const [reconWs] = await h.db.select().from(workspaces).where(eq(workspaces.id, recon.workspaceId));
    expect(reconWs.status).toBe("closed");
    expect(reconWs.mergedAt).not.toBeNull();
    const [reconIssue] = await h.db.select().from(issues).where(eq(issues.id, recon.issueId));
    expect(reconIssue.statusId).toBe(statusIds["Done"]); // genuinely merged work converges to Done
  });
});
