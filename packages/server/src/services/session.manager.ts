import type { WSContext } from "hono/ws";
import { db } from "../db/index.js";
import { sessions, workspaces, sessionMessages, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentService from "./agent.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

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

    // Detect system/init events to capture claudeSessionId
    if (message.type === "stdout" && message.data) {
      try {
        const obj = JSON.parse(message.data);
        if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
          db.update(sessions)
            .set({ claudeSessionId: obj.session_id })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update claudeSessionId:", err));
        }

        // Parse tool_use events for live activity
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
              }
            }
          }
        }
      } catch {
        // Not JSON or not a system/init event — ignore
      }
    }

    // On exit, clear activity
    if (message.type === "exit") {
      const ctx = sessionContexts.get(sessionId);
      if (ctx) {
        options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
      }
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
        claudeSessionId = prevRows[0].claudeSessionId;
        console.log(`[session] resuming: resumeFromId=${resumeFromId} claudeSessionId=${claudeSessionId}`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    console.log(`[session] starting: workspaceId=${workspaceId} sessionId=${sessionId} workingDir=${workspace.workingDir}`);

    // Cache session context for activity broadcasting
    sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });

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
      agentService.launch(workspace.workingDir, sessionId, prompt, agentArgs, (event) => {
        // Broadcast to WebSocket subscribers
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        // On exit, update session status
        if (event.type === "exit") {
          const endNow = new Date().toISOString();
          db.update(sessions)
            .set({ status: "completed", endedAt: endNow, exitCode: String(event.exitCode ?? 0) })
            .where(eq(sessions.id, sessionId))
            .then(() => {
              // Notify board that a session completed
              options?.onSessionExit?.(workspaceId, sessionId, event.exitCode ?? null);
              // Clean up cached context
              sessionContexts.delete(sessionId);
            })
            .catch((err) => console.error("Failed to update session:", err));
        }
      }, claudeSessionId, agentCommand);
    } catch (err) {
      throw err;
    }

    return sessionId;
  }

  /** Stop a running session by killing the agent process. */
  async function stopSession(sessionId: string) {
    console.log(`[session] stopping: sessionId=${sessionId}`);
    const killed = agentService.kill(sessionId);
    if (killed) {
      const now = new Date().toISOString();
      await db
        .update(sessions)
        .set({ status: "stopped", endedAt: now })
        .where(eq(sessions.id, sessionId));
    }
    return killed;
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

  return { startSession, stopSession, subscribe, unsubscribe, wsRoute };
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
