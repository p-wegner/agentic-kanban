import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";

/**
 * #876 — a launch that dies before the agent produces anything must END VISIBLY.
 *
 * The board inserts the session row as `running` and then does several hundred lines of
 * fallible, awaited work — provider rotation, devcontainer provisioning, worker placement —
 * before it spawns anything. A throw anywhere in that stretch used to escape with the row
 * still `running`: no pid, no process, no output, no failure record. The board believed an
 * agent was working; nothing was. #876 sat like that for fifteen minutes until the
 * completion-state reconciler swept it, and the reconciler said nothing either, so the only
 * artifact of the whole ticket was an empty workspace.
 *
 * `resolveProviderRotation` is mocked to throw purely because it is the FIRST awaited step
 * after the insert — it stands in for every step in that stretch, not for itself.
 */
const rotationThrows = vi.fn();
vi.mock("../services/session-manager/session-launch-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/session-manager/session-launch-helpers.js")>();
  return {
    ...actual,
    resolveProviderRotation: (...args: Parameters<typeof actual.resolveProviderRotation>) =>
      rotationThrows.getMockImplementation() ? rotationThrows(...args) : actual.resolveProviderRotation(...args),
  };
});

async function seedWorkspace(db: TestDb): Promise<string> {
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
    id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-876", workingDir: "/tmp/repo/.worktrees/ak-876",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

function agentServiceThatFailsToLaunch(message: string): AgentService {
  return {
    launch: vi.fn(() => { throw new Error(message); }),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

async function readSession(db: TestDb, workspaceId: string) {
  const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function readStderr(db: TestDb, sessionId: string): Promise<string> {
  const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  return rows.filter((r) => r.type === "stderr").map((r) => r.data ?? "").join("\n");
}

describe("session launch — a pre-spawn failure never leaves a phantom running session (#876)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
    rotationThrows.mockReset();
  });

  it("a throw BETWEEN the session insert and the spawn finalizes the row instead of orphaning it", async () => {
    const workspaceId = await seedWorkspace(db);
    rotationThrows.mockImplementation(() => { throw new Error("worker placement exploded"); });

    const agentService = agentServiceThatFailsToLaunch("should never be reached");
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow(/worker placement exploded/);
    expect(agentService.launch).not.toHaveBeenCalled();

    const session = await readSession(db, workspaceId);
    // Not `running` — that is the phantom the board then believes in.
    expect(session.status).toBe("stopped");
    // Not NULL — an indeterminate exit reads as "we never saw how it ended", which is
    // exactly the wrong thing to say about a failure we caught ourselves.
    expect(session.exitCode).toBe("1");
    // The reason has to reach the session output the UI renders, not just the console.
    expect(await readStderr(db, session.id)).toMatch(/worker placement exploded/);

    // The workspace must not stay `active` with nothing running in it.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");
  });

  it("a spawn-site failure finalizes through the SAME path, so both halves report alike", async () => {
    const workspaceId = await seedWorkspace(db);
    const agentService = agentServiceThatFailsToLaunch("claude.exe not found on PATH");
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow(/claude.exe not found/);

    const session = await readSession(db, workspaceId);
    expect(session.status).toBe("stopped");
    expect(session.exitCode).toBe("1");
    expect(await readStderr(db, session.id)).toMatch(/claude\.exe not found on PATH/);

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");
  });

  it("finalizes exactly once — the spawn-site catch and the wrapper do not both write", async () => {
    const workspaceId = await seedWorkspace(db);
    const agentService = agentServiceThatFailsToLaunch("boom");
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow(/boom/);

    const session = await readSession(db, workspaceId);
    const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, session.id));
    expect(rows.filter((r) => r.type === "stderr")).toHaveLength(1);
  });
});
