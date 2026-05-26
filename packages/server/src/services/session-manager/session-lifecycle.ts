import { db } from "../../db/index.js";
import { sessions, workspaces, issues, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentService from "../agent.service.js";
import { extractPlan, writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { SessionManagerOptions, SessionState, StartSessionOptions } from "./types.js";

export function createSessionLifecycle(
  state: SessionState,
  options: SessionManagerOptions | undefined,
  broadcast: (sessionId: string, message: AgentOutputMessage) => void,
) {
  /** Create a session DB row and launch the agent process. */
  async function startSession(opts: StartSessionOptions): Promise<string> {
    const {
      workspaceId,
      prompt,
      agentCommand,
      agentArgs,
      resumeFromId,
      claudeProfile,
      multiTurn,
      permissionPromptTool,
      planMode,
      resumeWithNewModel,
      provider,
      triggerType,
      profile,
      extraEnv,
      workingDirOverride,
      skipPermissions: skipPermissionsOpt,
    } = opts;

    // Look up workspace to get workingDir
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) throw new Error("Workspace not found");

    const workspace = wsRows[0];
    const effectiveWorkingDir = workingDirOverride ?? workspace.workingDir;
    if (!effectiveWorkingDir) throw new Error("Workspace has no working directory; run setup first");

    // Look up issue's projectId for activity broadcasting
    const issueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    const projectId = issueRows.length > 0 ? issueRows[0].projectId : "";

    const executor = provider ?? "claude-code";

    // If resuming, look up the previous session's providerSessionId. Session
    // IDs are provider-local, so never pass a Claude session ID to Copilot or vice versa.
    let providerSessionId: string | undefined;
    if (resumeFromId) {
      const prevRows = await db
        .select({ providerSessionId: sessions.providerSessionId, executor: sessions.executor })
        .from(sessions)
        .where(eq(sessions.id, resumeFromId))
        .limit(1);
      if (prevRows.length > 0 && prevRows[0].providerSessionId && prevRows[0].executor === executor) {
        // Skip mock agent session IDs (e.g. "mock-session-xxx") — they are not resumable
        const sid = prevRows[0].providerSessionId;
        if (!sid.startsWith("mock-session-")) {
          providerSessionId = sid;
          console.log(`[session] resuming: resumeFromId=${resumeFromId} providerSessionId=${providerSessionId}`);
        } else {
          console.log(`[session] skipping resume: providerSessionId=${sid} is a mock session ID`);
        }
      } else if (prevRows.length > 0 && prevRows[0].providerSessionId) {
        console.log(`[session] skipping resume: previous executor=${prevRows[0].executor} current executor=${executor}`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    console.log(`[session] starting: workspaceId=${workspaceId} sessionId=${sessionId} workingDir=${effectiveWorkingDir}`);

    // Cache session context for activity broadcasting
    state.sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });
    if (multiTurn) {
      state.turnStates.set(sessionId, "processing");
    }

    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor,
      status: "running",
      startedAt: now,
      endedAt: null,
      resumeFromId: resumeFromId ?? null,
      triggerType: triggerType ?? null,
    });
    state.sessionProviders.set(sessionId, executor);

    // Determine skip_permissions: explicit opt takes priority over global preference.
    const skipPermRows = await db.select().from(preferences).where(eq(preferences.key, "skip_permissions")).limit(1);
    const dbSkipPerms = skipPermRows.length > 0 && skipPermRows[0].value === "true";
    const skipPermissions = skipPermissionsOpt !== undefined ? skipPermissionsOpt : dbSkipPerms;

    // For Claude only: skip-permissions is conveyed via --dangerously-skip-permissions in agentArgs.
    let effectiveAgentArgs = agentArgs;
    if (executor === "claude-code") {
      if (skipPermissions && !effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs
          ? `${effectiveAgentArgs} --dangerously-skip-permissions`
          : "--dangerously-skip-permissions";
      } else if (!skipPermissions && effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs
          .split(/\s+/)
          .filter(a => a && a !== "--dangerously-skip-permissions")
          .join(" ") || undefined;
      }
    }

    // Inject HANDOFF.md context if available and not using provider resume or plan mode
    let effectivePrompt = prompt;
    if (effectiveWorkingDir && !planMode && !providerSessionId) {
      try {
        const { readHandoffFile } = await import("../handoff.service.js");
        const handoff = await readHandoffFile(effectiveWorkingDir);
        if (handoff) {
          effectivePrompt = `[SESSION HANDOFF — previous session context for this workspace. Use it to avoid re-reading files you already explored.]\n\n${handoff}\n---\n\n${prompt}`;
          console.log(`[session] HANDOFF.md injected: workspaceId=${workspaceId} size=${handoff.length}`);
        }
      } catch { /* handoff not available — proceed without it */ }
    }

    try {
      const proc = agentService.launch(effectiveWorkingDir, sessionId, effectivePrompt, effectiveAgentArgs, (event) => {
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        if (event.type === "exit") {
          // Always clean up in-memory state regardless of DB result
          state.sessionContexts.delete(sessionId);
          state.turnStates.delete(sessionId);
          state.sessionProviders.delete(sessionId);
          const hadExitPlanModeDenied = state.sessionExitPlanModeDenied.delete(sessionId);

          // Skip DB update if user explicitly stopped — stopSession already wrote "stopped"
          if (state.stoppedByUser.has(sessionId)) {
            state.stoppedByUser.delete(sessionId);
            state.sessionFinalText.delete(sessionId);
            options?.onSessionExit?.(workspaceId, sessionId, event.exitCode ?? null, planMode);
            return;
          }

          const planText = state.sessionFinalText.get(sessionId);
          state.sessionFinalText.delete(sessionId);

          const endNow = new Date().toISOString();
          const exitCode = event.exitCode ?? null;
          db.update(sessions)
            .set({ status: "completed", endedAt: endNow, exitCode: String(exitCode ?? 0) })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update session:", err));
          // Always fire the workflow callback — don't gate it on the DB update.
          options?.onSessionExit?.(workspaceId, sessionId, exitCode, planMode);

          // Auto-resume: if ExitPlanMode was denied and workspace wasn't in plan-only mode,
          // start a new session with --resume and a "proceed" prompt
          if (hadExitPlanModeDenied && !planMode) {
            const resumeCount = state.workspaceAutoResumeCount.get(workspaceId) ?? 0;
            if (resumeCount < 1) {
              state.workspaceAutoResumeCount.set(workspaceId, resumeCount + 1);
              console.log(`[session] auto-resuming after ExitPlanMode denial: workspaceId=${workspaceId} resumeFromId=${sessionId}`);
              startSession({
                workspaceId,
                prompt: "Your plan has been approved. Proceed with the implementation now.",
                agentCommand,
                agentArgs: effectiveAgentArgs,
                resumeFromId: sessionId,
                claudeProfile,
                multiTurn: undefined,
                permissionPromptTool,
                planMode: false,
                resumeWithNewModel: undefined,
                provider,
                triggerType: "agent",
                profile,
              }).catch((err) => console.error(`[session] auto-resume failed: workspaceId=${workspaceId}`, err));
            } else {
              console.log(`[session] skipping auto-resume: workspaceId=${workspaceId} already auto-resumed ${resumeCount} time(s)`);
            }
          }

          // Codex/Copilot plan mode: a read-only plan run just finished. Persist the plan to PLAN.md,
          // leave plan mode, then either auto-continue or park awaiting human approval.
          if (planMode && (provider === "codex" || provider === "copilot") && exitCode === 0 && workspace.workingDir && planText) {
            void (async () => {
              try {
                const plan = extractPlan(planText);
                if (!plan) {
                  console.warn(`[session] plan-mode run produced no plan text: workspaceId=${workspaceId}`);
                  return;
                }
                const planPath = writePlanFile(workspace.workingDir!, plan);
                await db.update(workspaces).set({ planMode: false, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId));

                const prefRows = await db.select().from(preferences).where(eq(preferences.key, "plan_auto_continue"));
                const autoContinue = prefRows.length === 0 || prefRows[0].value !== "false";

                if (autoContinue) {
                  console.log(`[session] plan ready (${planPath}) — auto-continuing to implementation: workspaceId=${workspaceId}`);
                  await startSession({
                    workspaceId,
                    prompt: buildImplementPrompt(),
                    agentCommand,
                    agentArgs: effectiveAgentArgs,
                    claudeProfile,
                    permissionPromptTool,
                    planMode: false,
                    provider,
                    triggerType: "plan-implement",
                    profile,
                  });
                } else {
                  console.log(`[session] plan ready (${planPath}) — awaiting human approval: workspaceId=${workspaceId}`);
                  await db.update(workspaces).set({ pendingPlanPath: planPath, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId));
                }
              } catch (err) {
                console.error(`[session] plan completion handling failed: workspaceId=${workspaceId}`, err);
              }
            })();
          }

          // Write HANDOFF.md for the next session on this workspace
          if (effectiveWorkingDir) {
            void (async () => {
              try {
                const { writeHandoffFile } = await import("../handoff.service.js");
                await writeHandoffFile(effectiveWorkingDir, sessionId, db, workspace.baseBranch);
                console.log(`[session] HANDOFF.md written: workspaceId=${workspaceId} sessionId=${sessionId}`);
              } catch (err) {
                console.warn(`[session] HANDOFF.md write failed: sessionId=${sessionId}`, err);
              }
            })();
          }
        }
      // When resumeWithNewModel is true, omit --resume so the new profile/provider is used instead
      }, resumeWithNewModel ? undefined : providerSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode, provider, profile, extraEnv, skipPermissions);

      // Persist PID so hot-reload can detect surviving processes
      if (proc.pid) {
        db.update(sessions)
          .set({ pid: proc.pid })
          .where(eq(sessions.id, sessionId))
          .catch((err) => console.error("Failed to store session pid:", err));
      }
    } catch (err) {
      // Clean up zombie session state if launch failed
      state.sessionContexts.delete(sessionId);
      state.turnStates.delete(sessionId);
      state.sessionProviders.delete(sessionId);
      await db.update(sessions)
        .set({ status: "stopped", endedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .catch(() => {});
      throw err;
    }

    return sessionId;
  }

  /** Stop a running session by closing stdin (graceful) then killing the agent process. */
  async function stopSession(sessionId: string): Promise<boolean> {
    console.log(`[session] stopping: sessionId=${sessionId}`);
    // Mark as user-stopped so the exit handler doesn't overwrite the DB status
    state.stoppedByUser.add(sessionId);
    // Clean up in-memory state immediately
    state.turnStates.delete(sessionId);
    // Try graceful shutdown first (close stdin so agent finishes)
    const closed = agentService.closeStdin(sessionId);
    if (closed) {
      // Give the agent a moment to exit gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // If still running, force kill
      if (agentService.getProcess(sessionId)) {
        agentService.kill(sessionId);
      }
    } else {
      agentService.kill(sessionId);
    }
    const now = new Date().toISOString();
    await db
      .update(sessions)
      .set({ status: "stopped", endedAt: now })
      .where(eq(sessions.id, sessionId));
    return true;
  }

  /** Send a follow-up message to a running session (multi-turn). */
  function sendTurn(sessionId: string, content: string): { ok: boolean; error?: string; stale?: boolean } {
    const turnState = state.turnStates.get(sessionId);
    if (!turnState) {
      // Session exited (turnStates cleared on exit) — treat as stale so caller can --resume
      if (!isProcessAlive(sessionId)) {
        return { ok: false, error: "Agent process has exited", stale: true };
      }
      return { ok: false, error: "Session not found or not in multi-turn mode" };
    }
    if (turnState !== "waiting") {
      // Check if the process is actually still alive before reporting "still processing"
      if (!isProcessAlive(sessionId)) {
        cleanupStaleSession(sessionId).catch(err => console.error("Failed to cleanup stale session:", err));
        return { ok: false, error: "Agent process is no longer running", stale: true };
      }
      return { ok: false, error: "Agent is still processing the previous turn" };
    }
    // Even in "waiting" state, verify the process is alive
    if (!isProcessAlive(sessionId)) {
      cleanupStaleSession(sessionId).catch(err => console.error("Failed to cleanup stale session:", err));
      return { ok: false, error: "Agent process is no longer running", stale: true };
    }
    const sent = agentService.sendInput(sessionId, content);
    if (!sent) {
      return { ok: false, error: "Failed to send input to agent (stdin closed or process gone)" };
    }
    state.turnStates.set(sessionId, "processing");
    return { ok: true };
  }

  /** Get the current turn state for a session. */
  function getTurnState(sessionId: string): "processing" | "waiting" | undefined {
    return state.turnStates.get(sessionId);
  }

  /** Check if an agent process is actually alive. Returns false if process is gone. */
  function isProcessAlive(sessionId: string): boolean {
    return agentService.isPidAlive(sessionId);
  }

  /** Clean up stale in-memory state for a session whose process is gone. */
  async function cleanupStaleSession(sessionId: string): Promise<void> {
    console.log(`[session] cleaning up stale session: sessionId=${sessionId}`);
    state.sessionContexts.delete(sessionId);
    state.turnStates.delete(sessionId);
    state.sessionSubagents.delete(sessionId);
    state.sessionTasks.delete(sessionId);
    state.sessionHasTodoWrite.delete(sessionId);
    state.sessionToolUses.delete(sessionId);
    state.sessionModels.delete(sessionId);
    state.sessionContextTokens.delete(sessionId);
    state.sessionLastTool.delete(sessionId);
    state.sessionAgentToolUseIds.delete(sessionId);
    state.sessionProviders.delete(sessionId);
    const now = new Date().toISOString();
    await db.update(sessions)
      .set({ status: "stopped", endedAt: now })
      .where(eq(sessions.id, sessionId));
    // Also reset workspace status to idle
    const sessionRows = await db.select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (sessionRows.length > 0) {
      await db.update(workspaces)
        .set({ status: "idle", updatedAt: now })
        .where(eq(workspaces.id, sessionRows[0].workspaceId));
    }
  }

  /**
   * Reattach to a surviving agent session after server restart.
   * Restores in-memory state so broadcast(), activity, and exit handling work.
   */
  function reattachSession(opts: {
    sessionId: string;
    workspaceId: string;
    issueId: string;
    projectId: string;
    providerName?: string;
  }): void {
    const { sessionId, workspaceId, issueId, projectId, providerName } = opts;
    state.sessionContexts.set(sessionId, { workspaceId, issueId, projectId });
    if (providerName) state.sessionProviders.set(sessionId, providerName);
    console.log(`[session] reattached: sessionId=${sessionId} workspaceId=${workspaceId} provider=${providerName ?? "unknown"}`);
  }

  /**
   * Notify that an externally-monitored session's process has exited.
   * Mirrors the exit handling in startSession's onOutput callback.
   */
  async function notifyExternalExit(sessionId: string, exitCode: number | null): Promise<void> {
    const ctx = state.sessionContexts.get(sessionId);
    // Clear in-memory state
    state.sessionContexts.delete(sessionId);
    state.turnStates.delete(sessionId);
    state.sessionProviders.delete(sessionId);
    state.sessionSubagents.delete(sessionId);
    state.sessionTasks.delete(sessionId);
    state.sessionHasTodoWrite.delete(sessionId);
    state.sessionToolUses.delete(sessionId);
    state.sessionModels.delete(sessionId);
    state.sessionContextTokens.delete(sessionId);
    state.sessionLastTool.delete(sessionId);
    state.sessionAgentToolUseIds.delete(sessionId);
    state.sessionTextParts.delete(sessionId);
    state.sessionFinalText.delete(sessionId);
    state.sessionExitPlanModeDenied.delete(sessionId);

    // Clear activity and todos for this session
    if (ctx) {
      options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
      options?.onTodos?.(ctx.projectId, ctx.issueId, []);
    }

    // Update DB
    const now = new Date().toISOString();
    await db.update(sessions)
      .set({ status: "completed", endedAt: now, exitCode: String(exitCode ?? 0) })
      .where(eq(sessions.id, sessionId));

    // Fire workflow callback
    const wsId = ctx?.workspaceId;
    if (wsId) {
      options?.onSessionExit?.(wsId, sessionId, exitCode, false);
    }
  }

  return {
    startSession,
    stopSession,
    sendTurn,
    getTurnState,
    isProcessAlive,
    cleanupStaleSession,
    reattachSession,
    notifyExternalExit,
  };
}
