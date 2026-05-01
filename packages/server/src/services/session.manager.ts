import type { WSContext } from "hono/ws";
import { db } from "../db/index.js";
import { sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentService from "./agent.service.js";
import * as gitService from "./git.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

interface Subscriber {
  ws: WSContext;
}

function createSessionManager(
  upgradeWebSocket: (callback: (c: any) => any) => any,
) {
  const subscribers = new Map<string, Set<Subscriber>>();

  function broadcast(sessionId: string, message: AgentOutputMessage) {
    const subs = subscribers.get(sessionId);
    if (!subs) return;
    const payload = JSON.stringify(message);
    for (const sub of subs) {
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

    const sessionId = randomUUID();
    const now = new Date().toISOString();

    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "claude-code",
      status: "running",
      startedAt: now,
      endedAt: null,
    });

    // Override agent command for testing if provided
    const prevAgentCommand = process.env.AGENT_COMMAND;
    if (agentCommand) {
      process.env.AGENT_COMMAND = agentCommand;
    }

    try {
      agentService.launch(workspace.workingDir, sessionId, prompt, (event) => {
        // Broadcast to WebSocket subscribers
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        // On exit, update session status
        if (event.type === "exit") {
          const endNow = new Date().toISOString();
          db.update(sessions)
            .set({ status: "completed", endedAt: endNow, exitCode: String(event.exitCode ?? 0) })
            .where(eq(sessions.id, sessionId))
            .catch((err) => console.error("Failed to update session:", err));
        }
      });
    } finally {
      if (agentCommand && prevAgentCommand !== undefined) {
        process.env.AGENT_COMMAND = prevAgentCommand;
      }
    }

    return sessionId;
  }

  /** Stop a running session by killing the agent process. */
  async function stopSession(sessionId: string) {
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
      subscribers.set(sessionId, new Set());
    }
    subscribers.get(sessionId)!.add({ ws });
  }

  /** Unsubscribe a WebSocket from session output. */
  function unsubscribe(sessionId: string, ws: WSContext) {
    const subs = subscribers.get(sessionId);
    if (subs) {
      subs.delete({ ws });
      if (subs.size === 0) {
        subscribers.delete(sessionId);
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
