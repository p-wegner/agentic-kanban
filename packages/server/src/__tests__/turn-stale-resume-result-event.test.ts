/**
 * #934 — a `/turn` whose resume target no longer exists must fall back to a fresh launch
 * carrying the turn content, instead of exiting 1 and silently dropping it.
 *
 * The #26 missing-transcript fallback already existed and was covered by
 * `session-lifecycle.test.ts` — but only for the case where the provider writes
 * "No conversation found with session ID: …" to STDERR. Live on #922 the Claude CLI
 * reported it on STDOUT instead, as a terminal stream-json result event:
 *
 *   {"type":"result","subtype":"error_during_execution","is_error":true,
 *    "errors":["No conversation found with session ID: 924e766f-…"]}
 *
 * Two things made that invisible to the recovery:
 *   1. nothing read `errors`, so the exit classifier's error text was the empty string and
 *      `isStaleResumeError("")` was false; and
 *   2. that result event sets stats/turnComplete, so `hadSubstantiveOutput` was TRUE and the
 *      exit routed to `completed` rather than `launch-failure` — the route the recovery is on.
 *
 * The workspace therefore went back to `idle` with no commit and no visible error, and the
 * follow-up content was lost. These tests drive the REAL provider parser and the REAL event
 * cascade (`applyStreamEvent`), so they fail if either half regresses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { parseAgentProviderStreamLine } from "@agentic-kanban/shared/lib/agent-stream-parser";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionState, type SessionState } from "../services/session-manager/types.js";
import { applyStreamEvent } from "../services/session-manager/broadcast.js";
import { classifySessionExit } from "../services/session-manager/session-exit-state-machine.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { AgentLaunchRequest } from "../services/agent-dispatch.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

/** The exact line the Claude CLI emitted on #922 when its `--resume` transcript was gone. */
function staleResumeResultLine(staleToken: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [`No conversation found with session ID: ${staleToken}`],
    duration_ms: 1200,
    num_turns: 0,
  });
}

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
    id: issueId, issueNumber: 922, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-922", workingDir: "/tmp/repo/.worktrees/ak-922",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

function createFakeAgentService(): { service: AgentService; getOnOutput: () => AgentOutputCallback | undefined } {
  let captured: AgentOutputCallback | undefined;
  const service = {
    launch: vi.fn((request: AgentLaunchRequest) => {
      captured = request.onOutput;
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

/**
 * A broadcast fake that runs the REAL event cascade over stdout, exactly as the production
 * broadcaster does — minus its DB writes. Without this the test would pass on a fake that
 * never populates the state the exit classifier reads, i.e. it would not test the bug.
 */
function createParsingBroadcast(state: SessionState) {
  return vi.fn((sid: string, message: AgentOutputMessage) => {
    if (!state.messageBuffer.has(sid)) state.messageBuffer.set(sid, []);
    state.messageBuffer.get(sid)!.push(message);
    if (message.type === "stdout" && message.data) {
      for (const line of message.data.split("\n")) {
        if (!line.trim()) continue;
        const evt = parseAgentProviderStreamLine("claude", line);
        if (evt) applyStreamEvent(state, undefined, sid, evt);
      }
    }
    if (message.type === "exit") {
      state.sessionFinalText.set(sid, (state.sessionTextParts.get(sid) ?? []).join("\n\n"));
      state.sessionTextParts.delete(sid);
    }
  });
}

async function flush(until?: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (until?.()) return;
  }
}

describe("#934 — the stale-resume error arrives as a result EVENT, not on stderr", () => {
  describe("the parser surfaces it", () => {
    it("carries `errors[]` off a failed result event as resultError", () => {
      const evt = parseAgentProviderStreamLine("claude", staleResumeResultLine("924e766f"));
      expect(evt?.resultError).toContain("No conversation found with session ID: 924e766f");
      expect(evt?.stats?.success).toBe(false);
    });

    it("leaves resultError unset on a SUCCESSFUL result, so nothing reads a success as an error", () => {
      const evt = parseAgentProviderStreamLine(
        "claude",
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 10 }),
      );
      expect(evt?.stats?.success).toBe(true);
      expect(evt?.resultError).toBeUndefined();
    });
  });

  describe("the exit classifier routes it to launch-failure", () => {
    const base = {
      exitCode: 1,
      durationMs: 45_000, // WELL outside the 10s launch-failure window — the #922 shape
      stoppedByUser: false,
      usageLimit: null,
      planText: null,
      capturedStderr: "",
    };

    it("routes a non-zero exit whose only output was a failed result to launch-failure, carrying the reason", () => {
      const route = classifySessionExit({
        ...base,
        // The failed result event sets stats/turnComplete, so this is TRUE — which is exactly
        // why the old classifier sent this to `completed`.
        hadSubstantiveOutput: true,
        hadAgentWork: false,
        resultErrorText: "No conversation found with session ID: 924e766f",
      });
      expect(route.phase).toBe("launch-failure");
      if (route.phase !== "launch-failure") throw new Error("unreachable");
      expect(route.errorText).toContain("No conversation found");
    });

    it("still routes a LONG run that did real work and then failed to completed, keeping its exit code", () => {
      const route = classifySessionExit({
        ...base,
        hadSubstantiveOutput: true,
        hadAgentWork: true, // the agent edited files / called tools before failing
        resultErrorText: "the model returned an error",
      });
      expect(route.phase).toBe("completed");
    });

    it("defaults hadAgentWork to hadSubstantiveOutput, so an un-updated caller cannot reclassify a real run", () => {
      const route = classifySessionExit({
        ...base,
        hadSubstantiveOutput: true,
        resultErrorText: "the model returned an error",
      });
      expect(route.phase).toBe("completed");
    });
  });

  describe("end to end: the turn's content is relaunched instead of dropped", () => {
    let db: TestDb;
    beforeEach(() => {
      ({ db } = createTestDb());
    });

    it("falls back to a fresh launch carrying the turn content", async () => {
      const workspaceId = await seedWorkspace(db);
      const { service: agentService, getOnOutput } = createFakeAgentService();
      const state = createSessionState();
      const lifecycle = createSessionLifecycle(
        state,
        undefined,
        createParsingBroadcast(state),
        { db, agentService, preflight: okPreflight() },
      );

      // The prior session, holding a resume token whose transcript expired ~10h later.
      const staleToken = "claude-stale-" + randomUUID();
      const prevSessionId = randomUUID();
      await db.insert(sessions).values({
        id: prevSessionId, workspaceId, executor: "claude-code", status: "completed",
        startedAt: new Date().toISOString(), providerSessionId: staleToken,
      });

      // This is what POST /:id/turn does: startSession with the turn content as the prompt,
      // resuming from the last session.
      const turnContent = "please also update the changelog";
      const sessionId = await lifecycle.startSession({
        workspaceId, prompt: turnContent, resumeFromId: prevSessionId, triggerType: "chat",
      });
      expect((agentService.launch as ReturnType<typeof vi.fn>).mock.calls[0][0].providerSessionId).toBe(staleToken);

      // The failure as it actually arrived: a result event on STDOUT, nothing on stderr.
      const onOutput = getOnOutput()!;
      onOutput({ type: "stdout", data: staleResumeResultLine(staleToken) } as never);
      onOutput({ type: "exit", exitCode: 1 } as never);

      await flush(() => (agentService.launch as ReturnType<typeof vi.fn>).mock.calls.length >= 2);

      // Recognised as a stale resume rather than a completed run.
      const failedRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(JSON.parse(failedRows[0].stats!).staleResumeRecovered).toBe(true);

      // The dead resume token is cleared so it can never be forwarded again.
      const prevRows = await db.select().from(sessions).where(eq(sessions.id, prevSessionId));
      expect(prevRows[0].providerSessionId).toBeNull();

      // A fresh launch WITHOUT --resume, still carrying the turn's content.
      expect(agentService.launch).toHaveBeenCalledTimes(2);
      const relaunch = (agentService.launch as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(relaunch.providerSessionId).toBeUndefined();
      expect(relaunch.prompt).toContain(turnContent);
      expect(relaunch.prompt).toContain("resume recovery");
    });

    it("clears the per-workspace retry budget once a session completes, so a later stale resume recovers too", async () => {
      const workspaceId = await seedWorkspace(db);
      const { service: agentService, getOnOutput } = createFakeAgentService();
      const state = createSessionState();
      const lifecycle = createSessionLifecycle(
        state,
        undefined,
        createParsingBroadcast(state),
        { db, agentService, preflight: okPreflight() },
      );
      // A recovery already happened at some point in this process's life.
      state.workspaceStaleResumeRecoveryCount.set(workspaceId, 1);
      expect(lifecycle.staleResumeRecoveryExhausted(workspaceId)).toBe(true);

      await lifecycle.startSession({ workspaceId, prompt: "do the work" });
      const onOutput = getOnOutput()!;
      onOutput({ type: "stdout", data: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }) } as never);
      onOutput({ type: "exit", exitCode: 0 } as never);
      await flush(() => !lifecycle.staleResumeRecoveryExhausted(workspaceId));

      // A run that actually completed proves the workspace can launch — the bound is spent per
      // stale-resume EPISODE, not once per workspace for the life of the process.
      expect(lifecycle.staleResumeRecoveryExhausted(workspaceId)).toBe(false);
    });
  });

  describe("when the fallback is NOT available, /turn refuses instead of accepting", () => {
    let db: TestDb;
    beforeEach(() => {
      ({ db } = createTestDb());
    });

    it("throws TRANSCRIPT_GONE rather than returning a resumed sessionId for content it cannot deliver", async () => {
      const workspaceId = await seedWorkspace(db);
      await db.insert(sessions).values({
        id: randomUUID(), workspaceId, executor: "claude-code", status: "completed",
        startedAt: new Date().toISOString(), providerSessionId: "dead-token",
      });

      const startSession = vi.fn(async () => randomUUID());
      const service = createWorkspaceSessionService({
        database: db as never,
        getSessionManager: () => ({
          startSession,
          sendTurn: vi.fn(() => ({ ok: true })),
          // The recovery budget for this workspace is spent and nothing has completed since.
          staleResumeRecoveryExhausted: () => true,
        }) as never,
      });

      await expect(service.sendTurn(workspaceId, "please also update the changelog"))
        .rejects.toMatchObject({ code: "CONFLICT", data: { code: "TRANSCRIPT_GONE" } });
      // The point of refusing: no session is started, so the caller is never told the content
      // was accepted when it was about to be dropped.
      expect(startSession).not.toHaveBeenCalled();
    });

    it("resumes normally when the budget is intact", async () => {
      const workspaceId = await seedWorkspace(db);
      await db.insert(sessions).values({
        id: randomUUID(), workspaceId, executor: "claude-code", status: "completed",
        startedAt: new Date().toISOString(), providerSessionId: "live-token",
      });

      const startSession = vi.fn(async () => "new-session");
      const service = createWorkspaceSessionService({
        database: db as never,
        getSessionManager: () => ({
          startSession,
          sendTurn: vi.fn(() => ({ ok: true })),
          staleResumeRecoveryExhausted: () => false,
        }) as never,
      });

      const result = await service.sendTurn(workspaceId, "carry on");
      expect(result).toEqual({ type: "resumed", sessionId: "new-session" });
      expect(startSession).toHaveBeenCalledOnce();
    });
  });
});
