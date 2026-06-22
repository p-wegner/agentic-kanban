import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, agentSkills } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

/**
 * Unit tests for the session lifecycle using an in-memory SQLite DB plus an
 * injected fake agent service. No real subprocess spawn (no vi.mock of
 * node:child_process) — the process factory is injected.
 */

/**
 * Seed a project + issue + an active worktree workspace; returns the workspace id.
 * Pass `skill` to attach an agent skill to the workspace.
 */
async function seedWorkspace(
  db: TestDb,
  skill?: { id: string; name: string },
): Promise<string> {
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
  if (skill) {
    await db.insert(agentSkills).values({
      id: skill.id, name: skill.name, description: "d", prompt: "p",
      createdAt: now, updatedAt: now,
    });
  }
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/repo/.worktrees/ak-1",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    skillId: skill?.id ?? null,
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

/**
 * Build a fake agent service. `launch` records the onOutput callback so tests can
 * later drive lifecycle events (e.g. fire an "exit") deterministically.
 */
function createFakeAgentService(): { service: AgentService; getOnOutput: () => AgentOutputCallback | undefined } {
  let captured: AgentOutputCallback | undefined;
  const service = {
    launch: vi.fn((_dir, _sid, _prompt, _args, onOutput: AgentOutputCallback) => {
      captured = onOutput;
      return createMockProc();
    }),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
  return { service, getOnOutput: () => captured };
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

/** Flush pending microtasks so fire-and-forget DB writes (`.catch()`) settle. */
async function flush(predicate?: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    if (!predicate || predicate()) return;
  }
}

describe("session-lifecycle", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("startSession inserts a running session row and launches the agent process", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    const broadcast = vi.fn();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, broadcast, { db, agentService, preflight: okPreflight() });

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    expect(sessionId).toBeTruthy();
    expect(agentService.launch).toHaveBeenCalledOnce();
    // The agent runs in the workspace's working directory
    const launchArgs = (agentService.launch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(launchArgs[0]).toBe("/tmp/repo/.worktrees/ak-1");

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    expect(rows[0].workspaceId).toBe(workspaceId);
  });

  it("records the workspace's skill (id + snapshotted name) on the session row", async () => {
    const skill = { id: randomUUID(), name: "code-review" };
    const workspaceId = await seedWorkspace(db, skill);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });
    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].skillId).toBe(skill.id);
    expect(rows[0].skillName).toBe("code-review");
  });

  it("leaves skill fields null when the workspace has no skill", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });
    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].skillId).toBeNull();
    expect(rows[0].skillName).toBeNull();
  });

  it("launches Codex builders with a safe explicit model, counter-instructions, and launch diagnostics", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });
    const sessionId = await lifecycle.startSession({
      workspaceId,
      prompt: "do it",
      provider: "codex",
      triggerType: "agent",
      systemInstructions: "Base guardrails.",
    });

    const launchArgs = (agentService.launch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(launchArgs[15]).toBe("gpt-5.5");
    expect(launchArgs[17]).toContain("Base guardrails.");
    expect(launchArgs[17]).toContain("MUST run relevant tests and COMMIT");

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    const stats = JSON.parse(rows[0].stats!);
    expect(stats.launch.resolvedModel).toBe("gpt-5.5");
    expect(stats.launch.provider).toBe("codex");
    expect(stats.launch.systemInstructionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("blocks Codex builder launches that resolve to gpt-5.3-codex-spark", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({
      workspaceId,
      prompt: "do it",
      provider: "codex",
      triggerType: "agent",
      model: "gpt-5.3-codex-spark",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "UNSAFE_CODEX_MODEL", model: "gpt-5.3-codex-spark" },
    });

    expect(agentService.launch).not.toHaveBeenCalled();
    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("marks the session completed and fires onSessionExit when the process exits cleanly", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    state.sessionSubstantiveOutput.add(sessionId);

    // Drive the exit event the way agent.service would
    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush(() => onSessionExit.mock.calls.length > 0);

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("completed");
    expect(rows[0].exitCode).toBe("0");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 0, undefined);
  });

  it("marks a fast provider exit with no model output as a stopped launch failure", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();

    const lifecycle = createSessionLifecycle(
      createSessionState(),
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it", provider: "codex" });

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush();

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("stopped");
    expect(rows[0].exitCode).toBe("1");
    const stats = JSON.parse(rows[0].stats!);
    expect(stats.launchFailure).toBe(true);
    expect(stats.success).toBe(false);
    expect(stats.numTurns).toBe(0);
    expect(stats.agentSummary).toContain("provider process exited");

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 1, undefined);
  });

  it("marks Codex usage-limit exits as blocked instead of idle", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();
    const broadcast = vi.fn((sessionId: string, message: AgentOutputMessage) => {
      if (!state.messageBuffer.has(sessionId)) state.messageBuffer.set(sessionId, []);
      state.messageBuffer.get(sessionId)!.push(message);
    });

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      broadcast,
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it", provider: "codex" });

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({
      type: "stdout",
      data: [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.failed",
          error: {
            message: "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Jun 6th, 2026 12:30 AM.",
          },
        }),
      ].join("\n"),
    } as never);
    onOutput!({ type: "exit", exitCode: 1 } as never);

    await flush(() => onSessionExit.mock.calls.length > 0);

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("stopped");
    expect(rows[0].exitCode).toBe("1");
    const stats = JSON.parse(rows[0].stats!);
    expect(stats.rateLimited).toBe(true);
    expect(stats.rateLimitKind).toBe("codex-usage-limit");
    expect(stats.retryAfter).toBe("Jun 6th, 2026 12:30 AM");
    expect(stats.failureReason).toContain("usage limit");

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("blocked");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 1, undefined);
  });

  it("marks the session stopped and rethrows when the agent fails to launch", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    (agentService.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(state, undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow("spawn ENOENT");

    // A row was inserted before launch; on failure it is flipped to "stopped"
    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("stopped");
    // In-memory zombie state was cleaned up
    expect(state.sessionContexts.size).toBe(0);
  });

  it("blocks launch before spawning when workspace safety preflight fails", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    const preflight = vi.fn(async () => ({
      ok: false,
      errors: ["Workspace safety policy is stale; checkpoint/commit first."],
      staleFiles: [".codex/hooks.json"],
      refreshed: false,
      dirtyFiles: [" M src/changed.ts"],
    })) as unknown as typeof workspaceLaunchPreflight;

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight });

    let thrown: unknown;
    try {
      await lifecycle.startSession({ workspaceId, prompt: "do it" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceError);
    const wsErr = thrown as WorkspaceError;
    expect(wsErr.code).toBe("CONFLICT");
    expect(wsErr.data?.code).toBe("STALE_SAFETY_POLICY");
    expect(wsErr.data?.staleFiles).toContain(".codex/hooks.json");
    expect(wsErr.message).toContain("checkpoint/commit");
    expect(preflight).toHaveBeenCalledOnce();
    expect(agentService.launch).not.toHaveBeenCalled();

    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  // --- Session state machine transitions ---

  it("flags a short non-zero exit with substantive output as a model-error launch failure (#699)", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    // Simulate the model-error scenario: the CLI outputs an error message as assistantText
    // (which the broadcast handler records as "substantive output"), then exits non-zero.
    // This was the 2026-06-08 default_model outage: Claude got --model gpt-5.5, printed
    // "There is an issue with the selected model", and exited code 1 in ~5s.
    state.sessionSubstantiveOutput.add(sessionId);
    state.sessionFinalText.set(sessionId, "There is an issue with the selected model");

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 1 } as never);

    await flush(() => onSessionExit.mock.calls.length > 0);

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    // Session is "stopped" (not "completed") with launchFailure stamped
    expect(rows[0].status).toBe("stopped");
    expect(rows[0].exitCode).toBe("1");
    const stats = JSON.parse(rows[0].stats!);
    expect(stats.launchFailure).toBe(true);
    expect(stats.success).toBe(false);
    expect(stats.agentSummary).toContain("issue with the selected model");

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 1, undefined);
  });

  it("transitions running->completed when the agent process exits cleanly (exit code 0)", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    state.sessionSubstantiveOutput.add(sessionId);

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush(() => onSessionExit.mock.calls.length > 0);

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("completed");
    expect(rows[0].exitCode).toBe("0");
    expect(rows[0].endedAt).not.toBeNull();
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 0, undefined);
    // In-memory context must be cleaned up after exit
    expect(state.sessionContexts.has(sessionId)).toBe(false);
    expect(state.sessionProviders.has(sessionId)).toBe(false);
  });

  it("marks workspace idle and session stopped when cleanupStaleSession is called for a dead PID", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      undefined,
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    // Start a session so a DB row exists in "running" status
    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    // Simulate a stuck-running session: PID is gone but the exit event never fired
    // (hot-reload / server-restart scenario where the agent process died silently)
    await lifecycle.cleanupStaleSession(sessionId);

    const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessionRows[0].status).toBe("stopped");
    expect(sessionRows[0].endedAt).not.toBeNull();

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");

    // In-memory state must be purged
    expect(state.sessionContexts.has(sessionId)).toBe(false);
    expect(state.turnStates.has(sessionId)).toBe(false);
    expect(state.sessionProviders.has(sessionId)).toBe(false);
  });

  it("stopSession on an already-stopped session is a no-op (does not throw)", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    state.sessionSubstantiveOutput.add(sessionId);

    // First stop — legitimate user stop
    await lifecycle.stopSession(sessionId);

    const rowsAfterFirstStop = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rowsAfterFirstStop[0].status).toBe("stopped");

    // Second stop on the same (already-stopped) session must not throw
    await expect(lifecycle.stopSession(sessionId)).resolves.toBe(true);

    // DB still shows stopped; no duplicate side effects
    const rowsAfterSecondStop = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rowsAfterSecondStop[0].status).toBe("stopped");
  });
});
