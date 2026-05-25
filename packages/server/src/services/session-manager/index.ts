import type { WSContext } from "hono/ws";
import { db } from "../../db/index.js";
import { sessions, workspaces, sessionMessages, issues, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentService from "../agent.service.js";
import { getProvider } from "../agent-provider.js";
import { extractPlan, writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { SessionState, SessionManagerOptions, StartSessionOptions } from "./types.js";
import { formatToolActivity, tasksToTodoItems } from "./utils.js";
export type { StartSessionOptions } from "./types.js";

function createSessionState(): SessionState {
  return {
    subscribers: new Map(),
    messageBuffer: new Map(),
    sessionContexts: new Map(),
    turnStates: new Map(),
    stoppedByUser: new Set(),
    sessionToolUses: new Map(),
    sessionModels: new Map(),
    sessionSubagents: new Map(),
    sessionContextTokens: new Map(),
    sessionLastTool: new Map(),
    sessionAgentToolUseIds: new Map(),
    sessionTextParts: new Map(),
    sessionFinalText: new Map(),
    sessionTasks: new Map(),
    sessionHasTodoWrite: new Set(),
    sessionExitPlanModeDenied: new Set(),
    workspaceAutoResumeCount: new Map(),
    sessionProviders: new Map(),
  };
}

function createSessionManager(
  upgradeWebSocket: (callback: (c: any) => any) => any,
  options?: SessionManagerOptions,
) {
  const state = createSessionState();

  function broadcast(sessionId: string, message: AgentOutputMessage) {
    if (!state.messageBuffer.has(sessionId)) {
      state.messageBuffer.set(sessionId, []);
    }
    state.messageBuffer.get(sessionId)!.push(message);

    db.insert(sessionMessages).values({
      sessionId,
      type: message.type,
      data: message.data ?? null,
      exitCode: message.exitCode != null ? String(message.exitCode) : null,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_CONSTRAINT_FOREIGNKEY") && !msg.includes("FOREIGN KEY")) {
        console.error("Failed to persist session message:", err);
      }
    });

    if (message.type === "stdout" && message.data) {
      const providerName = state.sessionProviders.get(sessionId);
      const provider = getProvider(providerName);
      for (const line of message.data.split("\n")) {
        if (!line.trim()) continue;
        const evt = provider.parseStreamEvent(line);
        if (!evt) continue;

        const ctx = state.sessionContexts.get(sessionId);

        if (evt.providerSessionId) {
          db.update(sessions)
            .set({ providerSessionId: evt.providerSessionId })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update providerSessionId:", err));
        }

        if (evt.exitPlanModeDenied) {
          state.sessionExitPlanModeDenied.add(sessionId);
          console.log(`[session] ExitPlanMode denied: sessionId=${sessionId} — will auto-resume if planMode=false`);
        }

        if (evt.turnComplete && agentService.isStdinOpen(sessionId)) {
          state.turnStates.set(sessionId, "waiting");
        }

        if (evt.assistantText) {
          if (!state.sessionTextParts.has(sessionId)) state.sessionTextParts.set(sessionId, []);
          state.sessionTextParts.get(sessionId)!.push(evt.assistantText);
        }

        if (evt.stats) {
          const lastTool = state.sessionLastTool.get(sessionId);
          const textParts = state.sessionTextParts.get(sessionId) ?? [];
          const fullAgentSummary = textParts.length > 0 ? textParts.join("\n\n---\n\n") : evt.stats.agentSummary;
          const statsToSave = { ...evt.stats, agentSummary: fullAgentSummary, ...(lastTool ? { lastTool } : {}) };
          db.update(sessions)
            .set({ stats: JSON.stringify(statsToSave) })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update session stats:", err));
        }

        if (evt.liveStats) {
          const ls = evt.liveStats;
          if (ls.model) state.sessionModels.set(sessionId, ls.model);
          if (ls.contextTokens > 0) state.sessionContextTokens.set(sessionId, ls.contextTokens);
          if (ls.toolUses !== undefined) state.sessionToolUses.set(sessionId, ls.toolUses);

          if (ls.subagentDelta === 1) {
            const count = (state.sessionSubagents.get(sessionId) ?? 0) + 1;
            state.sessionSubagents.set(sessionId, count);
          }

          const model = state.sessionModels.get(sessionId) ?? "";
          const contextTokens = state.sessionContextTokens.get(sessionId) ?? 0;
          const toolUses = state.sessionToolUses.get(sessionId) ?? 0;
          const subagentCount = state.sessionSubagents.get(sessionId) ?? 0;
          if (ctx && (model || contextTokens || toolUses || subagentCount)) {
            options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, contextTokens, toolUses, subagentCount);
          }
        }

        if (evt.toolActivity && ctx) {
          state.sessionLastTool.set(sessionId, evt.toolActivity.name);
          const activity = formatToolActivity(evt.toolActivity.name, evt.toolActivity.input);
          if (activity) {
            options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, activity);
          }

          if (evt.toolActivity.name === "Agent" && evt.toolActivity.toolUseId) {
            if (!state.sessionAgentToolUseIds.has(sessionId)) state.sessionAgentToolUseIds.set(sessionId, new Set());
            state.sessionAgentToolUseIds.get(sessionId)!.add(evt.toolActivity.toolUseId);
          }

          if (evt.toolActivity.name === "TodoWrite" && evt.todos) {
            state.sessionHasTodoWrite.add(sessionId);
            if (ctx) {
              options?.onTodos?.(ctx.projectId, ctx.issueId, evt.todos as unknown as import("../board-events.js").TodoItem[]);
            }
          }

          if (!state.sessionHasTodoWrite.has(sessionId) && evt.toolActivity.name === "TaskCreate") {
            const subject = evt.toolActivity.input.subject as string | undefined;
            if (subject) {
              if (!state.sessionTasks.has(sessionId)) state.sessionTasks.set(sessionId, new Map());
              const tasks = state.sessionTasks.get(sessionId)!;
              const taskIdx = String(tasks.size + 1);
              tasks.set(taskIdx, { subject, status: "pending" });
              if (ctx) {
                options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks));
              }
            }
          }

          if (evt.toolActivity.name === "TaskUpdate" && !state.sessionHasTodoWrite.has(sessionId)) {
            const taskId = evt.toolActivity.input.taskId as string | undefined;
            const taskStatus = evt.toolActivity.input.status as string | undefined;
            if (taskId && taskStatus) {
              const tasks = state.sessionTasks.get(sessionId);
              const task = tasks?.get(taskId);
              if (task) {
                task.status = taskStatus;
                if (ctx) {
                  options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks!));
                }
              }
            }
          }
        }

        if (evt.rateLimitInfo) {
          console.warn(`[agent] rate_limit_event: sessionId=${sessionId} status=${evt.rateLimitInfo.status} type=${evt.rateLimitInfo.rateLimitType}`);
        }

        if (evt.toolResult) {
          const agentIds = state.sessionAgentToolUseIds.get(sessionId);
          if (agentIds && agentIds.has(evt.toolResult.toolUseId)) {
            if (evt.toolResult.agentResultText) {
              if (!state.sessionTextParts.has(sessionId)) state.sessionTextParts.set(sessionId, []);
              state.sessionTextParts.get(sessionId)!.push(evt.toolResult.agentResultText);
            }
            agentIds.delete(evt.toolResult.toolUseId);
            const newCount = Math.max(0, (state.sessionSubagents.get(sessionId) ?? 1) - 1);
            state.sessionSubagents.set(sessionId, newCount);
            if (ctx) {
              const model = state.sessionModels.get(sessionId) ?? "";
              const toolUses = state.sessionToolUses.get(sessionId) ?? 0;
              const lastContextTokens = state.sessionContextTokens.get(sessionId) ?? 0;
              options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, lastContextTokens, toolUses, newCount);
            }
          }
        }
      }
    }

    if (message.type === "exit") {
      const ctx = state.sessionContexts.get(sessionId);
      if (ctx) {
        options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
        options?.onTodos?.(ctx.projectId, ctx.issueId, []);
      }
      state.sessionSubagents.delete(sessionId);
      state.sessionTasks.delete(sessionId);
      state.sessionHasTodoWrite.delete(sessionId);
      state.sessionToolUses.delete(sessionId);
      state.sessionModels.delete(sessionId);
      state.sessionContextTokens.delete(sessionId);
      state.sessionLastTool.delete(sessionId);
      state.sessionAgentToolUseIds.delete(sessionId);
      state.sessionFinalText.set(sessionId, (state.sessionTextParts.get(sessionId) ?? []).join("\n\n"));
      state.sessionTextParts.delete(sessionId);
      state.sessionExitPlanModeDenied.delete(sessionId);
    }

    const subs = state.subscribers.get(sessionId);
    if (!subs) return;
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  async function startSession(opts: StartSessionOptions) {
    const {
      workspaceId, prompt, agentCommand, agentArgs, resumeFromId, claudeProfile,
      multiTurn, permissionPromptTool, planMode, resumeWithNewModel, provider,
      triggerType, profile, extraEnv, workingDirOverride, skipPermissions: skipPermissionsOpt,
    } = opts;

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) throw new Error("Workspace not found");

    const workspace = wsRows[0];
    const effectiveWorkingDir = workingDirOverride ?? workspace.workingDir;
    if (!effectiveWorkingDir) throw new Error("Workspace has no working directory; run setup first");

    const issueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    const projectId = issueRows.length > 0 ? issueRows[0].projectId : "";

    const executor = provider ?? "claude-code";

    let providerSessionId: string | undefined;
    if (resumeFromId) {
      const prevRows = await db
        .select({ providerSessionId: sessions.providerSessionId, executor: sessions.executor })
        .from(sessions)
        .where(eq(sessions.id, resumeFromId))
        .limit(1);
      if (prevRows.length > 0 && prevRows[0].providerSessionId && prevRows[0].executor === executor) {
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

    state.sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });
    if (multiTurn) {
      state.turnStates.set(sessionId, "processing");
    }

    await db.insert(sessions).values({
      id: sessionId, workspaceId, executor, status: "running", startedAt: now, endedAt: null,
      resumeFromId: resumeFromId ?? null, triggerType: triggerType ?? null,
    });
    state.sessionProviders.set(sessionId, executor);

    const skipPermRows = await db.select().from(preferences).where(eq(preferences.key, "skip_permissions")).limit(1);
    const dbSkipPerms = skipPermRows.length > 0 && skipPermRows[0].value === "true";
    const skipPermissions = skipPermissionsOpt !== undefined ? skipPermissionsOpt : dbSkipPerms;

    let effectiveAgentArgs = agentArgs;
    if (executor === "claude-code") {
      if (skipPermissions && !effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs ? `${effectiveAgentArgs} --dangerously-skip-permissions` : "--dangerously-skip-permissions";
      } else if (!skipPermissions && effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs.split(/\s+/).filter(a => a && a !== "--dangerously-skip-permissions").join(" ") || undefined;
      }
    }

    try {
      const proc = agentService.launch(effectiveWorkingDir, sessionId, prompt, effectiveAgentArgs, (event) => {
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        if (event.type === "exit") {
          state.sessionContexts.delete(sessionId);
          state.turnStates.delete(sessionId);
          state.sessionProviders.delete(sessionId);
          const hadExitPlanModeDenied = state.sessionExitPlanModeDenied.delete(sessionId);

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
          options?.onSessionExit?.(workspaceId, sessionId, exitCode, planMode);

          if (hadExitPlanModeDenied && !planMode) {
            const resumeCount = state.workspaceAutoResumeCount.get(workspaceId) ?? 0;
            if (resumeCount < 1) {
              state.workspaceAutoResumeCount.set(workspaceId, resumeCount + 1);
              console.log(`[session] auto-resuming after ExitPlanMode denial: workspaceId=${workspaceId} resumeFromId=${sessionId}`);
              startSession({
                workspaceId, prompt: "Your plan has been approved. Proceed with the implementation now.",
                agentCommand, agentArgs, resumeFromId: sessionId, claudeProfile,
                multiTurn: undefined, permissionPromptTool, planMode: false,
                resumeWithNewModel: undefined, provider, triggerType: "agent", profile,
              }).catch((err) => console.error(`[session] auto-resume failed: workspaceId=${workspaceId}`, err));
            } else {
              console.log(`[session] skipping auto-resume: workspaceId=${workspaceId} already auto-resumed ${resumeCount} time(s)`);
            }
          }

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
                    workspaceId, prompt: buildImplementPrompt(), agentCommand, agentArgs,
                    claudeProfile, permissionPromptTool, planMode: false, provider,
                    triggerType: "plan-implement", profile,
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
        }
      }, resumeWithNewModel ? undefined : providerSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode, provider, profile, extraEnv, skipPermissions);

      if (proc.pid) {
        db.update(sessions).set({ pid: proc.pid }).where(eq(sessions.id, sessionId))
          .catch((err) => console.error("Failed to store session pid:", err));
      }
    } catch (err) {
      throw err;
    }

    return sessionId;
  }

  async function stopSession(sessionId: string) {
    console.log(`[session] stopping: sessionId=${sessionId}`);
    state.stoppedByUser.add(sessionId);
    state.turnStates.delete(sessionId);
    const closed = agentService.closeStdin(sessionId);
    if (closed) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (agentService.getProcess(sessionId)) {
        agentService.kill(sessionId);
      }
    } else {
      agentService.kill(sessionId);
    }
    const now = new Date().toISOString();
    await db.update(sessions).set({ status: "stopped", endedAt: now }).where(eq(sessions.id, sessionId));
    return true;
  }

  function subscribe(sessionId: string, ws: WSContext) {
    if (!state.subscribers.has(sessionId)) {
      state.subscribers.set(sessionId, new Map());
    }
    state.subscribers.get(sessionId)!.set(ws, { ws });
    console.log(`[session] WS subscribed: sessionId=${sessionId} subscribers=${state.subscribers.get(sessionId)!.size}`);

    const buffer = state.messageBuffer.get(sessionId);
    if (buffer) {
      for (const msg of buffer) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(msg));
        }
      }
    }
  }

  function unsubscribe(sessionId: string, ws: WSContext) {
    const subs = state.subscribers.get(sessionId);
    if (subs) {
      subs.delete(ws);
      console.log(`[session] WS unsubscribed: sessionId=${sessionId} subscribers=${subs.size}`);
      if (subs.size === 0) {
        state.subscribers.delete(sessionId);
        const buffer = state.messageBuffer.get(sessionId);
        if (buffer && buffer.length > 0 && buffer[buffer.length - 1].type === "exit") {
          state.messageBuffer.delete(sessionId);
        }
      }
    }
  }

  function wsRoute() {
    return upgradeWebSocket((c: any) => {
      const sessionId = c.req.param("sessionId");
      return {
        onOpen(_event: any, ws: WSContext) { subscribe(sessionId, ws); },
        onClose(_event: any, ws: WSContext) { unsubscribe(sessionId, ws); },
      };
    });
  }

  function isProcessAlive(sessionId: string): boolean {
    return agentService.isPidAlive(sessionId);
  }

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
    const now = new Date().toISOString();
    await db.update(sessions).set({ status: "stopped", endedAt: now }).where(eq(sessions.id, sessionId));
    const sessionRows = await db.select({ workspaceId: sessions.workspaceId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (sessionRows.length > 0) {
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, sessionRows[0].workspaceId));
    }
  }

  function sendTurn(sessionId: string, content: string): { ok: boolean; error?: string; stale?: boolean } {
    const turnState = state.turnStates.get(sessionId);
    if (!turnState) {
      if (!isProcessAlive(sessionId)) {
        return { ok: false, error: "Agent process has exited", stale: true };
      }
      return { ok: false, error: "Session not found or not in multi-turn mode" };
    }
    if (turnState !== "waiting") {
      if (!isProcessAlive(sessionId)) {
        cleanupStaleSession(sessionId).catch(err => console.error("Failed to cleanup stale session:", err));
        return { ok: false, error: "Agent process is no longer running", stale: true };
      }
      return { ok: false, error: "Agent is still processing the previous turn" };
    }
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

  function getTurnState(sessionId: string): "processing" | "waiting" | undefined {
    return state.turnStates.get(sessionId);
  }

  function reattachSession(opts: {
    sessionId: string; workspaceId: string; issueId: string; projectId: string; providerName?: string;
  }): void {
    const { sessionId, workspaceId, issueId, projectId, providerName } = opts;
    state.sessionContexts.set(sessionId, { workspaceId, issueId, projectId });
    if (providerName) state.sessionProviders.set(sessionId, providerName);
    console.log(`[session] reattached: sessionId=${sessionId} workspaceId=${workspaceId} provider=${providerName ?? "unknown"}`);
  }

  async function notifyExternalExit(sessionId: string, exitCode: number | null): Promise<void> {
    const ctx = state.sessionContexts.get(sessionId);
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

    if (ctx) {
      options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
      options?.onTodos?.(ctx.projectId, ctx.issueId, []);
    }

    const now = new Date().toISOString();
    await db.update(sessions).set({ status: "completed", endedAt: now, exitCode: String(exitCode ?? 0) }).where(eq(sessions.id, sessionId));

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
    subscribe,
    unsubscribe,
    wsRoute,
    isProcessAlive,
    reattachSession,
    notifyExternalExit,
    handleOutput: broadcast,
  };
}

export { createSessionManager };
