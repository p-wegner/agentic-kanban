import type { WSContext } from "hono/ws";
import { db } from "../db/index.js";
import { sessions, workspaces, sessionMessages, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentService from "./agent.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { TodoItem } from "./board-events.js";

interface Subscriber {
  ws: WSContext;
}

interface SessionContext {
  workspaceId: string;
  issueId: string;
  projectId: string;
}

interface SessionManagerOptions {
  onSessionExit?: (workspaceId: string, sessionId: string, exitCode: number | null) => void;
  onActivity?: (projectId: string, issueId: string, sessionId: string, activity: string) => void;
  onLiveStats?: (projectId: string, issueId: string, model: string, contextTokens: number, toolUses: number, subagentCount: number) => void;
  onTodos?: (projectId: string, issueId: string, todos: TodoItem[]) => void;
}

function createSessionManager(
  upgradeWebSocket: (callback: (c: any) => any) => any,
  options?: SessionManagerOptions,
) {
  const subscribers = new Map<string, Map<WSContext, Subscriber>>();
  // Buffer messages per session so late-connecting WS clients get missed output
  const messageBuffer = new Map<string, AgentOutputMessage[]>();
  // Cache session context for activity broadcasting (avoids DB queries per stdout line)
  const sessionContexts = new Map<string, SessionContext>();
  // Track turn state per session: "processing" = agent is working, "waiting" = sent result, awaiting input
  const turnStates = new Map<string, "processing" | "waiting">();
  // Track sessions explicitly stopped by user — exit handler should not overwrite their status
  const stoppedByUser = new Set<string>();
  // Track cumulative tool uses per session for live stats (providers like ZAI don't report tokens per-turn)
  const sessionToolUses = new Map<string, number>();
  // Track last known model per session for result-event stats broadcasts
  const sessionModels = new Map<string, string>();
  // Track active subagent count per session (Agent tool_use calls)
  const sessionSubagents = new Map<string, number>();
  // Track last known context token count per session for subagent/task_progress broadcasts
  const sessionContextTokens = new Map<string, number>();
  // Track Agent tool_use IDs per session to decrement count when tool_result arrives
  const sessionAgentToolUseIds = new Map<string, Set<string>>();
  // Track tasks from TaskCreate/TaskUpdate calls per session
  const sessionTasks = new Map<string, Map<string, { subject: string; status: string }>>();
  // Track whether a TodoWrite has been seen for each session (takes precedence over TaskCreate/TaskUpdate)
  const sessionHasTodoWrite = new Set<string>();

  function broadcast(sessionId: string, message: AgentOutputMessage) {
    // Buffer the message for late subscribers
    if (!messageBuffer.has(sessionId)) {
      messageBuffer.set(sessionId, []);
    }
    messageBuffer.get(sessionId)!.push(message);

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
      for (const line of message.data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
            db.update(sessions)
              .set({ claudeSessionId: obj.session_id })
              .where(eq(sessions.id, sessionId))
              .catch((err) => console.error("Failed to update claudeSessionId:", err));
          }

          // Detect result events — in multi-turn mode, this means turn complete, not session complete
          if (obj.type === "result" && agentService.isStdinOpen(sessionId)) {
            turnStates.set(sessionId, "waiting");
          }

          // Extract stats from result events and persist to sessions table
          if (obj.type === "result") {
            const usage = obj.usage as Record<string, unknown> | undefined;
            const rawCost = obj.total_cost_usd ?? obj.cost_usd;
            const agentSummary = typeof obj.result === "string" ? obj.result : undefined;
            const stats = JSON.stringify({
              durationMs: (obj.duration_ms as number) ?? 0,
              totalCostUsd: typeof rawCost === "number" ? rawCost : 0,
              inputTokens: (usage?.input_tokens as number) ?? 0,
              outputTokens: (usage?.output_tokens as number) ?? 0,
              numTurns: (obj.num_turns as number) ?? 1,
              model: (obj.model as string) ?? "",
              success: obj.subtype === "success" && !obj.is_error,
              agentSummary,
            });
            db.update(sessions)
              .set({ stats })
              .where(eq(sessions.id, sessionId))
              .catch((err) => console.error("Failed to update session stats:", err));
          }

          // Broadcast live model + context size from each assistant turn
          if (obj.type === "assistant" && obj.message) {
            const usage = obj.message.usage as Record<string, unknown> | undefined;
            const model = (obj.message.model as string) ?? "";
            const contextTokens = ((usage?.cache_read_input_tokens as number) ?? 0) + ((usage?.input_tokens as number) ?? 0);
            if (model) sessionModels.set(sessionId, model);
            if (contextTokens > 0) sessionContextTokens.set(sessionId, contextTokens);
            const toolUses = sessionToolUses.get(sessionId) ?? 0;
            const subagentCount = sessionSubagents.get(sessionId) ?? 0;
            const ctx = sessionContexts.get(sessionId);
            if (ctx && (model || contextTokens || toolUses || subagentCount)) {
              options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, contextTokens, toolUses, subagentCount);
            }
          }

          // Track tool_uses from task_progress events (live proxy for providers that don't report tokens per-turn)
          if (obj.type === "system" && obj.subtype === "task_progress" && obj.usage) {
            const tpUsage = obj.usage as { tool_uses?: number };
            if (tpUsage.tool_uses) {
              sessionToolUses.set(sessionId, tpUsage.tool_uses);
              const model = sessionModels.get(sessionId) ?? "";
              const subagentCount = sessionSubagents.get(sessionId) ?? 0;
              const lastContextTokens = sessionContextTokens.get(sessionId) ?? 0;
              const ctx = sessionContexts.get(sessionId);
              if (ctx) {
                options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, lastContextTokens, tpUsage.tool_uses, subagentCount);
              }
            }
          }

          // Broadcast final stats from result event (some providers only report usage here)
          if (obj.type === "result" && obj.usage) {
            const rUsage = obj.usage as Record<string, unknown>;
            const contextTokens = ((rUsage.cache_read_input_tokens as number) ?? 0) + ((rUsage.input_tokens as number) ?? 0);
            const model = sessionModels.get(sessionId) ?? "";
            const toolUses = sessionToolUses.get(sessionId) ?? 0;
            const subagentCount = sessionSubagents.get(sessionId) ?? 0;
            const ctx = sessionContexts.get(sessionId);
            if (ctx && (contextTokens || toolUses || subagentCount)) {
              options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, contextTokens, toolUses, subagentCount);
            }
          }

          // Parse tool_use events for live activity, todos, and subagent tracking
          if (obj.type === "assistant" && obj.message?.content) {
            const content = obj.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_use") {
                  const activity = formatToolActivity(block.name, block.input);
                  const ctx = sessionContexts.get(sessionId);
                  if (ctx && activity) {
                    options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, activity);
                  }
                  // Capture TodoWrite calls to show task progress on the board
                  if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
                    const ctx = sessionContexts.get(sessionId);
                    if (ctx) {
                      sessionHasTodoWrite.add(sessionId);
                      options?.onTodos?.(ctx.projectId, ctx.issueId, block.input.todos as TodoItem[]);
                    }
                  }
                  // Track Agent tool calls as active subagents
                  if (block.name === "Agent") {
                    if (block.id) {
                      if (!sessionAgentToolUseIds.has(sessionId)) sessionAgentToolUseIds.set(sessionId, new Set());
                      sessionAgentToolUseIds.get(sessionId)!.add(block.id);
                    }
                    const count = (sessionSubagents.get(sessionId) ?? 0) + 1;
                    sessionSubagents.set(sessionId, count);
                    const model = sessionModels.get(sessionId) ?? "";
                    const toolUses = sessionToolUses.get(sessionId) ?? 0;
                    const lastContextTokens = sessionContextTokens.get(sessionId) ?? 0;
                    if (ctx) {
                      options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, lastContextTokens, toolUses, count);
                    }
                  }
                  // Track TaskCreate calls (skip if TodoWrite has taken precedence)
                  if (block.name === "TaskCreate" && block.input?.subject && !sessionHasTodoWrite.has(sessionId)) {
                    if (!sessionTasks.has(sessionId)) sessionTasks.set(sessionId, new Map());
                    const tasks = sessionTasks.get(sessionId)!;
                    const taskIdx = String(tasks.size + 1);
                    tasks.set(taskIdx, { subject: block.input.subject as string, status: "pending" });
                    if (ctx) {
                      options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks));
                    }
                  }
                  // Track TaskUpdate calls (skip if TodoWrite has taken precedence)
                  if (block.name === "TaskUpdate" && block.input?.taskId && block.input?.status && !sessionHasTodoWrite.has(sessionId)) {
                    const tasks = sessionTasks.get(sessionId);
                    if (tasks) {
                      const task = tasks.get(block.input.taskId as string);
                      if (task) {
                        task.status = block.input.status as string;
                        if (ctx) {
                          options?.onTodos?.(ctx.projectId, ctx.issueId, tasksToTodoItems(tasks));
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // Decrement subagent count when tool_result arrives for a tracked Agent tool_use
          if (obj.type === "user" && obj.message?.content) {
            const content = obj.message.content;
            if (Array.isArray(content)) {
              const agentIds = sessionAgentToolUseIds.get(sessionId);
              if (agentIds && agentIds.size > 0) {
                for (const block of content) {
                  if (block.type === "tool_result" && block.tool_use_id && agentIds.has(block.tool_use_id)) {
                    agentIds.delete(block.tool_use_id);
                    const newCount = Math.max(0, (sessionSubagents.get(sessionId) ?? 1) - 1);
                    sessionSubagents.set(sessionId, newCount);
                    const ctx = sessionContexts.get(sessionId);
                    if (ctx) {
                      const model = sessionModels.get(sessionId) ?? "";
                      const toolUses = sessionToolUses.get(sessionId) ?? 0;
                      const lastContextTokens = sessionContextTokens.get(sessionId) ?? 0;
                      options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, lastContextTokens, toolUses, newCount);
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Not JSON or not a recognized event — ignore
        }
      }
    }

    // On exit, clear activity, todos, and subagent state
    if (message.type === "exit") {
      const ctx = sessionContexts.get(sessionId);
      if (ctx) {
        options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
        options?.onTodos?.(ctx.projectId, ctx.issueId, []);
        // Broadcast final stats with zero subagents
        const model = sessionModels.get(sessionId) ?? "";
        const toolUses = sessionToolUses.get(sessionId) ?? 0;
        const lastContextTokens = sessionContextTokens.get(sessionId) ?? 0;
        options?.onLiveStats?.(ctx.projectId, ctx.issueId, model, lastContextTokens, toolUses, 0);
      }
      sessionSubagents.delete(sessionId);
      sessionTasks.delete(sessionId);
      sessionHasTodoWrite.delete(sessionId);
      sessionToolUses.delete(sessionId);
      sessionModels.delete(sessionId);
      sessionContextTokens.delete(sessionId);
      sessionAgentToolUseIds.delete(sessionId);
    }

    const subs = subscribers.get(sessionId);
    if (!subs) return;
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  /** Create a session DB row and launch the agent process. */
  async function startSession(
    workspaceId: string,
    prompt: string,
    agentCommand?: string,
    agentArgs?: string,
    resumeFromId?: string,
    claudeProfile?: string,
    multiTurn?: boolean,
    permissionPromptTool?: string,
    planMode?: boolean,
    resumeWithNewModel?: boolean,
  ) {
    // Look up workspace to get workingDir
    const wsRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (wsRows.length === 0) {
      throw new Error("Workspace not found");
    }

    const workspace = wsRows[0];
    if (!workspace.workingDir) {
      throw new Error("Workspace has no working directory; run setup first");
    }

    // Look up issue's projectId for activity broadcasting
    const issueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    const projectId = issueRows.length > 0 ? issueRows[0].projectId : "";

    // If resuming, look up the previous session's claudeSessionId
    let claudeSessionId: string | undefined;
    if (resumeFromId) {
      const prevRows = await db
        .select({ claudeSessionId: sessions.claudeSessionId })
        .from(sessions)
        .where(eq(sessions.id, resumeFromId))
        .limit(1);
      if (prevRows.length > 0 && prevRows[0].claudeSessionId) {
        // Skip non-UUID session IDs (e.g. mock agent "mock-session-xxx")
        const sid = prevRows[0].claudeSessionId;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
          claudeSessionId = sid;
          console.log(`[session] resuming: resumeFromId=${resumeFromId} claudeSessionId=${claudeSessionId}`);
        } else {
          console.log(`[session] skipping resume: claudeSessionId=${sid} is not a valid UUID`);
        }
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    console.log(`[session] starting: workspaceId=${workspaceId} sessionId=${sessionId} workingDir=${workspace.workingDir}`);

    // Cache session context for activity broadcasting
    sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });
    if (multiTurn) {
      turnStates.set(sessionId, "processing");
    }

    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "claude-code",
      status: "running",
      startedAt: now,
      endedAt: null,
      resumeFromId: resumeFromId ?? null,
    });

    try {
      agentService.launch(workspace.workingDir, sessionId, prompt, agentArgs, (event) => { // onOutput callback
        // Broadcast to WebSocket subscribers
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        // On exit, update session status
        if (event.type === "exit") {
          // Always clean up in-memory state regardless of DB result
          sessionContexts.delete(sessionId);
          turnStates.delete(sessionId);

          // Skip DB update if user explicitly stopped — stopSession already wrote "stopped"
          if (stoppedByUser.has(sessionId)) {
            stoppedByUser.delete(sessionId);
            options?.onSessionExit?.(workspaceId, sessionId, event.exitCode ?? null);
            return;
          }

          const endNow = new Date().toISOString();
          const exitCode = event.exitCode ?? null;
          db.update(sessions)
            .set({ status: "completed", endedAt: endNow, exitCode: String(exitCode ?? 0) })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update session:", err));
          // Always fire the workflow callback — don't gate it on the DB update
          options?.onSessionExit?.(workspaceId, sessionId, exitCode);
        }
      // When resumeWithNewModel is true, omit --resume so the new profile/provider is used instead
      }, resumeWithNewModel ? undefined : claudeSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode);
    } catch (err) {
      throw err;
    }

    return sessionId;
  }

  /** Stop a running session by closing stdin (graceful) then killing the agent process. */
  async function stopSession(sessionId: string) {
    console.log(`[session] stopping: sessionId=${sessionId}`);
    // Mark as user-stopped so the exit handler doesn't overwrite the DB status
    stoppedByUser.add(sessionId);
    // Clean up in-memory state immediately
    turnStates.delete(sessionId);
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

  /** Subscribe a WebSocket to session output. */
  function subscribe(sessionId: string, ws: WSContext) {
    if (!subscribers.has(sessionId)) {
      subscribers.set(sessionId, new Map());
    }
    subscribers.get(sessionId)!.set(ws, { ws });
    console.log(`[session] WS subscribed: sessionId=${sessionId} subscribers=${subscribers.get(sessionId)!.size}`);

    // Replay buffered messages so late subscribers don't miss output
    const buffer = messageBuffer.get(sessionId);
    if (buffer) {
      for (const msg of buffer) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(msg));
        }
      }
    }
  }

  /** Unsubscribe a WebSocket from session output. */
  function unsubscribe(sessionId: string, ws: WSContext) {
    const subs = subscribers.get(sessionId);
    if (subs) {
      subs.delete(ws);
      console.log(`[session] WS unsubscribed: sessionId=${sessionId} subscribers=${subs.size}`);
      if (subs.size === 0) {
        subscribers.delete(sessionId);
        // Clean up buffer if session has ended
        const buffer = messageBuffer.get(sessionId);
        if (buffer && buffer.length > 0 && buffer[buffer.length - 1].type === "exit") {
          messageBuffer.delete(sessionId);
        }
      }
    }
  }

  /** Return the WebSocket route handler for /ws/sessions/:sessionId. */
  function wsRoute() {
    return upgradeWebSocket((c: any) => {
      const sessionId = c.req.param("sessionId");
      return {
        onOpen(_event: any, ws: WSContext) {
          subscribe(sessionId, ws);
        },
        onClose(_event: any, ws: WSContext) {
          unsubscribe(sessionId, ws);
        },
      };
    });
  }

  /** Check if an agent process is actually alive. Returns false if process is gone. */
  function isProcessAlive(sessionId: string): boolean {
    const proc = agentService.getProcess(sessionId);
    if (!proc) return false;
    // On Windows, check if the process still exists via PID
    if (process.platform === "win32") {
      try {
        // Sending signal 0 checks existence without killing
        process.kill(proc.pid!, 0);
        return true;
      } catch {
        return false;
      }
    }
    return !proc.killed;
  }

  /** Clean up stale in-memory state for a session whose process is gone. */
  async function cleanupStaleSession(sessionId: string): Promise<void> {
    console.log(`[session] cleaning up stale session: sessionId=${sessionId}`);
    sessionContexts.delete(sessionId);
    turnStates.delete(sessionId);
    sessionSubagents.delete(sessionId);
    sessionTasks.delete(sessionId);
    sessionHasTodoWrite.delete(sessionId);
    sessionToolUses.delete(sessionId);
    sessionModels.delete(sessionId);
    sessionContextTokens.delete(sessionId);
    sessionAgentToolUseIds.delete(sessionId);
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

  /** Send a follow-up message to a running session (multi-turn). */
  function sendTurn(sessionId: string, content: string): { ok: boolean; error?: string; stale?: boolean } {
    const state = turnStates.get(sessionId);
    if (!state) {
      // Session exited (turnStates cleared on exit) — treat as stale so caller can --resume
      if (!isProcessAlive(sessionId)) {
        return { ok: false, error: "Agent process has exited", stale: true };
      }
      return { ok: false, error: "Session not found or not in multi-turn mode" };
    }
    if (state !== "waiting") {
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
    turnStates.set(sessionId, "processing");
    return { ok: true };
  }

  /** Get the current turn state for a session. */
  function getTurnState(sessionId: string): "processing" | "waiting" | undefined {
    return turnStates.get(sessionId);
  }

  return { startSession, stopSession, sendTurn, getTurnState, subscribe, unsubscribe, wsRoute };
}

export { createSessionManager };
export type SessionManager = ReturnType<typeof createSessionManager>;

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function formatToolActivity(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `Reading ${basename(input.file_path as string || "")}`;
    case "Edit":
      return `Editing ${basename(input.file_path as string || "")}`;
    case "Write":
      return `Writing ${basename(input.file_path as string || "")}`;
    case "Bash": {
      const cmd = (input.command as string || "").slice(0, 60);
      return `Running: ${cmd}`;
    }
    case "Grep":
      return `Searching for ${input.pattern || ""}`;
    case "Glob":
      return `Finding ${input.pattern || "files"}`;
    case "Agent":
      return `Delegating to agent`;
    case "WebSearch":
      return `Searching web`;
    case "WebFetch":
    case "mcp__web_reader__webReader":
      return `Fetching URL`;
    default:
      return name;
  }
}

function tasksToTodoItems(tasks: Map<string, { subject: string; status: string }>): TodoItem[] {
  return Array.from(tasks.entries()).map(([id, task]) => ({
    id,
    content: task.subject,
    status: (task.status === "in_progress" || task.status === "completed" || task.status === "pending")
      ? task.status as "pending" | "in_progress" | "completed"
      : "pending",
    priority: "medium" as const,
  }));
}
