import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, preferences } from "@agentic-kanban/shared/schema";
import { sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { reconcileStrandedPlanModeWorkspaces } from "../startup/plan-mode-reconciler.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";

const PLAN_BEGIN = "===PLAN BEGIN===";
const PLAN_END = "===PLAN END===";

function fakeBoardEvents(): BoardEvents {
  return {
    broadcast: vi.fn(),
    broadcastActivity: vi.fn(),
    broadcastLiveStats: vi.fn(),
    broadcastTodos: vi.fn(),
  } as unknown as BoardEvents;
}

/** Seed a plan-mode workspace stranded idle, plus a completed plan-trigger session. */
async function seedStrandedPlan(db: TestDb, opts?: { writePlanOut?: boolean }): Promise<{ workspaceId: string; sessionId: string; dir: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "ak924-recon-"));

  await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 7, title: "T", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-7", workingDir: dir, baseBranch: "main",
    isDirect: false, status: "idle", planMode: true, provider: "codex", createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "codex", status: "completed", startedAt: now, endedAt: now, exitCode: "0", triggerType: "plan" });

  if (opts?.writePlanOut) {
    const planText = `Here is the plan.\n${PLAN_BEGIN}\n# Plan\n1. Combine the tickets\n${PLAN_END}`;
    const line = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: planText } });
    writeFileSync(sessionOutputPath(sessionId), line + "\n", "utf-8");
  }
  return { workspaceId, sessionId, dir };
}

describe("reconcileStrandedPlanModeWorkspaces (#924)", () => {
  let db: TestDb;
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    ({ db } = createTestDb());
  });
  afterEach(() => {
    for (const f of cleanupFiles.splice(0)) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ }
      try { rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("recovers a stranded plan-mode workspace: writes PLAN.md, clears planMode, auto-continues", async () => {
    const { workspaceId, sessionId, dir } = await seedStrandedPlan(db, { writePlanOut: true });
    cleanupFiles.push(sessionOutputPath(sessionId), dir);
    const startSession = vi.fn(async () => randomUUID());
    const getSessionManager = () => ({ startSession } as unknown as SessionManager);

    const recovered = await reconcileStrandedPlanModeWorkspaces({ database: db, getSessionManager, boardEvents: fakeBoardEvents(), enabled: true });

    expect(recovered).toBe(1);
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(ws.planMode).toBe(false);
    expect(ws.status).toBe("active");
    expect(existsSync(join(dir, "PLAN.md"))).toBe(true);
    expect(readFileSync(join(dir, "PLAN.md"), "utf-8")).toContain("Combine the tickets");
    expect(startSession).toHaveBeenCalledOnce();
    expect(startSession.mock.calls[0][0]).toMatchObject({ workspaceId, planMode: false, triggerType: "plan-implement" });
  });

  it("parks at awaiting-plan-approval when plan_auto_continue is disabled", async () => {
    const { workspaceId, sessionId, dir } = await seedStrandedPlan(db, { writePlanOut: true });
    cleanupFiles.push(sessionOutputPath(sessionId), dir);
    await db.insert(preferences).values({ key: "plan_auto_continue", value: "false", updatedAt: new Date().toISOString() });
    const startSession = vi.fn(async () => randomUUID());
    const getSessionManager = () => ({ startSession } as unknown as SessionManager);

    await reconcileStrandedPlanModeWorkspaces({ database: db, getSessionManager, boardEvents: fakeBoardEvents(), enabled: true });

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(ws.planMode).toBe(false);
    expect(ws.status).toBe("awaiting-plan-approval");
    expect(ws.pendingPlanPath).toBe("PLAN.md");
    expect(startSession).not.toHaveBeenCalled();
  });

  it("clears planMode and marks blocked when no plan can be recovered from the .out file", async () => {
    const { workspaceId, sessionId, dir } = await seedStrandedPlan(db, { writePlanOut: false });
    cleanupFiles.push(dir);
    // No .out file written → nothing to recover.
    const startSession = vi.fn(async () => randomUUID());
    const getSessionManager = () => ({ startSession } as unknown as SessionManager);

    const recovered = await reconcileStrandedPlanModeWorkspaces({ database: db, getSessionManager, boardEvents: fakeBoardEvents(), enabled: true });

    expect(recovered).toBe(1);
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(ws.planMode).toBe(false);
    expect(ws.status).toBe("blocked");
    expect(startSession).not.toHaveBeenCalled();
  });

  it("skips a workspace that already parked awaiting approval (not stranded)", async () => {
    const { workspaceId, sessionId, dir } = await seedStrandedPlan(db, { writePlanOut: true });
    cleanupFiles.push(sessionOutputPath(sessionId), dir);
    await db.update(workspaces).set({ pendingPlanPath: "PLAN.md" }).where(eq(workspaces.id, workspaceId));
    const startSession = vi.fn(async () => randomUUID());

    const recovered = await reconcileStrandedPlanModeWorkspaces({
      database: db, getSessionManager: () => ({ startSession } as unknown as SessionManager), boardEvents: fakeBoardEvents(), enabled: true,
    });

    expect(recovered).toBe(0);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("skips when no prior plan-trigger session exists", async () => {
    const { workspaceId, dir } = await seedStrandedPlan(db, { writePlanOut: false });
    cleanupFiles.push(dir);
    // Remove the plan session so there is no completed plan run.
    await db.delete(sessions).where(eq(sessions.workspaceId, workspaceId));

    const recovered = await reconcileStrandedPlanModeWorkspaces({
      database: db, getSessionManager: () => ({ startSession: vi.fn() } as unknown as SessionManager), boardEvents: fakeBoardEvents(), enabled: true,
    });
    expect(recovered).toBe(0);
  });

  it("is a no-op when disabled via the deps override", async () => {
    const { sessionId, dir } = await seedStrandedPlan(db, { writePlanOut: true });
    cleanupFiles.push(sessionOutputPath(sessionId), dir);
    const recovered = await reconcileStrandedPlanModeWorkspaces({
      database: db, getSessionManager: () => ({ startSession: vi.fn() } as unknown as SessionManager), boardEvents: fakeBoardEvents(), enabled: false,
    });
    expect(recovered).toBe(0);
  });
});
