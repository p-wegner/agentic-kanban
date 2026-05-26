import type { WSContext } from "hono/ws";
import type { SessionState } from "./types.js";

export function createWsHandler(
  state: SessionState,
  upgradeWebSocket: (callback: (c: any) => any) => any,
) {
  function subscribe(sessionId: string, ws: WSContext) {
    if (!state.subscribers.has(sessionId)) {
      state.subscribers.set(sessionId, new Map());
    }
    state.subscribers.get(sessionId)!.set(ws, { ws });
    console.log(`[session] WS subscribed: sessionId=${sessionId} subscribers=${state.subscribers.get(sessionId)!.size}`);

    // Replay buffered messages so late subscribers don't miss output
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
        // Clean up buffer if session has ended
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

  return { subscribe, unsubscribe, wsRoute };
}
