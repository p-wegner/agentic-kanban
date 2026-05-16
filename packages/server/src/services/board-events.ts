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
}

type BoardWsMessage = BoardEventMessage | SessionActivityMessage | SessionStatsMessage;

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

  function broadcastLiveStats(projectId: string, issueId: string, model: string, contextTokens: number) {
    const subs = subscribers.get(projectId);
    if (!subs) return;
    const message: SessionStatsMessage = { type: "session_stats", projectId, issueId, model, contextTokens };
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

  return { subscribe, unsubscribe, broadcast, broadcastActivity, broadcastLiveStats, wsRoute };
}

export { createBoardEvents };
export type BoardEvents = ReturnType<typeof createBoardEvents>;
