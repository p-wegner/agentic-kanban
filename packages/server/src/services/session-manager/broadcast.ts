import { db } from "../../db/index.js";
import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as agentService from "../agent.service.js";
import { getProvider } from "../agent-provider.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { SessionManagerOptions, SessionState } from "./types.js";
import { formatToolActivity, tasksToTodoItems } from "./utils.js";
import type { TodoItem } from "../board-events.js";

export function createBroadcaster(
  state: SessionState,
  options: SessionManagerOptions | undefined,
) {
  return function broadcast(sessionId: string, message: AgentOutputMessage) {
    // Buffer message for late-connecting WS clients
    if (!state.messageBuffer.has(sessionId)) {
      state.messageBuffer.set(sessionId, []);
    }
    state.messageBuffer.get(sessionId)!.push(message);

    // Persist to database (fire-and-forget)
    db.insert(sessionMessages).values({
      sessionId,
      type: message.type,
      data: message.data ?? null,
      exitCode: message.exitCode != null ? String(message.exitCode) : null,
    }).catch((err: unknown) => {
      // FK constraint failure means the session was already deleted (race with workspace cleanup) — ignore
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_CONSTRAINT_FOREIGNKEY") && !msg.includes("FOREIGN KEY")) {
        console.error("Failed to persist session message:", err);
      }
    });

    // Parse stdout data — may contain multiple JSONL lines in a single chunk
    if (message.type === "stdout" && message.data) {
      const providerName = state.sessionProviders.get(sessionId);
      const provider = getProvider(providerName);
      for (const line of message.data.split("\n")) {
        if (!line.trim()) continue;
        const evt = provider.parseStreamEvent(line);
        if (!evt) continue;

        const ctx = state.sessionContexts.get(sessionId);

        // Provider session ID (e.g. Claude's system/init session_id)
        if (evt.providerSessionId) {
          db.update(sessions)
            .set({ providerSessionId: evt.providerSessionId })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update providerSessionId:", err));
        }

        // Track ExitPlanMode denial for auto-resume
        if (evt.exitPlanModeDenied) {
          state.sessionExitPlanModeDenied.add(sessionId);
          console.log(`[session] ExitPlanMode denied: sessionId=${sessionId} — will auto-resume if planMode=false`);
        }

        // Turn completion in multi-turn mode
        if (evt.turnComplete && agentService.isStdinOpen(sessionId)) {
          state.turnStates.set(sessionId, "waiting");
        }

        // Accumulate assistant text for agentSummary
        if (evt.assistantText) {
          if (!state.sessionTextParts.has(sessionId)) state.sessionTextParts.set(sessionId, []);
          state.sessionTextParts.get(sessionId)!.push(evt.assistantText);
        }

        // Persist session stats from result events
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

        // Live stats updates (model, context tokens, tool uses, subagents)
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

        // Tool activity broadcasting
        if (evt.toolActivity && ctx) {
          state.sessionLastTool.set(sessionId, evt.toolActivity.name);
          const activity = formatToolActivity(evt.toolActivity.name, evt.toolActivity.input);
          if (activity) {
            options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, activity);
          }

          // Track Agent tool_use IDs for subagent count decrement
          if (evt.toolActivity.name === "Agent" && evt.toolActivity.toolUseId) {
            if (!state.sessionAgentToolUseIds.has(sessionId)) state.sessionAgentToolUseIds.set(sessionId, new Set());
            state.sessionAgentToolUseIds.get(sessionId)!.add(evt.toolActivity.toolUseId);
          }

          // TodoWrite: set hasTodoWrite flag and broadcast todos
          if (evt.toolActivity.name === "TodoWrite" && evt.todos) {
            state.sessionHasTodoWrite.add(sessionId);
            options?.onTodos?.(ctx.projectId, ctx.issueId, evt.todos as unknown as TodoItem[]);
          }

          // TaskCreate (only when no TodoWrite has taken precedence)
          if (!state.sessionHasTodoWrite.has(sessionId) && evt.toolActivity.name === "TaskCreate") {
            const subject = evt.toolActivity.input.subject as string | undefined;
            if (subject) {
              if (!state.sessionTasks.has(sessionId)) state.sessionTasks.set(sessionId, new Map());
              const tasks = state.sessionTasks.get(sessionId)!;
              const taskIdx = String(tasks.size + 1);
              tasks.set(taskIdx, { subject, status: "pending" });
              options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks));
            }
          }

          // TaskUpdate — update task status by taskId
          if (evt.toolActivity.name === "TaskUpdate" && !state.sessionHasTodoWrite.has(sessionId)) {
            const taskId = evt.toolActivity.input.taskId as string | undefined;
            const taskStatus = evt.toolActivity.input.status as string | undefined;
            if (taskId && taskStatus) {
              const tasks = state.sessionTasks.get(sessionId);
              const task = tasks?.get(taskId);
              if (task) {
                task.status = taskStatus;
                options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks!));
              }
            }
          }
        }

        // Rate limit event: log for observability
        if (evt.rateLimitInfo) {
          console.warn(`[agent] rate_limit_event: sessionId=${sessionId} status=${evt.rateLimitInfo.status} type=${evt.rateLimitInfo.rateLimitType}`);
        }

        // Tool result: decrement subagent count for tracked Agent tool_use IDs
        if (evt.toolResult) {
          const agentIds = state.sessionAgentToolUseIds.get(sessionId);
          if (agentIds && agentIds.has(evt.toolResult.toolUseId)) {
            // Accumulate subagent response text
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

    // On exit, clear activity, todos, and transient per-session stats state
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

    // Deliver to WebSocket subscribers
    const subs = state.subscribers.get(sessionId);
    if (!subs) return;
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  };
}
