import type { WSContext } from "hono/ws";

interface BoardEventMessage {
  type: "board_changed";
  projectId: string;
  reason: string;
}

interface SessionActivityMessage {
  type: "session_activity";
  projectId: string;
  issueId: string;
  sessionId: string;
  activity: string;
}

interface SessionStatsMessage {
  type: "session_stats";
  projectId: string;
  issueId: string;
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

interface SessionTodosMessage {
  type: "session_todos";
  projectId: string;
  issueId: string;
  todos: TodoItem[];
}

export interface ApprovalRequestMessage {
  type: "approval_requested";
  projectId: string;
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  workspaceId?: string;
}

type BoardWsMessage = BoardEventMessage | SessionActivityMessage | SessionStatsMessage | SessionTodosMessage | ApprovalRequestMessage;

interface BoardEventSubscriber {
  ws: WSContext;
}

function createBoardEvents(
  upgradeWebSocket: (callback: (c: any) => any) => any,
) {
  const subscribers = new Map<string, Map<WSContext, BoardEventSubscriber>>();

  function subscribe(projectId: string, ws: WSContext) {
    if (!subscribers.has(projectId)) {
      subscribers.set(projectId, new Map());
    }
    subscribers.get(projectId)!.set(ws, { ws });
    console.log(`[board-events] WS subscribed: projectId=${projectId} subscribers=${subscribers.get(projectId)!.size}`);
  }

  function unsubscribe(projectId: string, ws: WSContext) {
    const subs = subscribers.get(projectId);
    if (subs) {
      subs.delete(ws);
      console.log(`[board-events] WS unsubscribed: projectId=${projectId} subscribers=${subs.size}`);
      if (subs.size === 0) {
        subscribers.delete(projectId);
      }
    }
  }

  function broadcast(projectId: string, reason: string) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: BoardEventMessage = { type: "board_changed", projectId, reason };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastActivity(projectId: string, data: Omit<SessionActivityMessage, "type" | "projectId">) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionActivityMessage = { type: "session_activity", projectId, ...data };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastLiveStats(projectId: string, issueId: string, model: string, contextTokens: number, toolUses: number, subagentCount: number) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionStatsMessage = { type: "session_stats", projectId, issueId, model, contextTokens, toolUses, subagentCount };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastApprovalRequest(projectId: string, data: Omit<ApprovalRequestMessage, "type" | "projectId">) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: ApprovalRequestMessage = { type: "approval_requested", projectId, ...data };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function broadcastTodos(projectId: string, issueId: string, todos: TodoItem[]) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionTodosMessage = { type: "session_todos", projectId, issueId, todos };
    const payload = JSON.stringify(message);
    for (const sub of subs.values()) {
      if (sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  function wsRoute() {
    return upgradeWebSocket((c: any) => {
      const projectId = c.req.param("projectId");
      return {
        onOpen(_event: any, ws: WSContext) {
          subscribe(projectId, ws);
        },
        onClose(_event: any, ws: WSContext) {
          unsubscribe(projectId, ws);
        },
      };
    });
  }

  return { subscribe, unsubscribe, broadcast, broadcastActivity, broadcastLiveStats, broadcastTodos, broadcastApprovalRequest, wsRoute };
}

export { createBoardEvents };
export type BoardEvents = ReturnType<typeof createBoardEvents>;
