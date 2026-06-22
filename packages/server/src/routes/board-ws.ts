import type { Context } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { BoardEvents } from "../services/board-events.js";

/**
 * Creates the WebSocket route handler for real-time board events.
 *
 * Extracted from the board-events service so that HTTP/WebSocket routing
 * concerns live in the routes layer rather than in the event service.
 *
 * Usage:
 *   app.get("/ws/board/:projectId", createBoardWsRoute(upgradeWebSocket, boardEvents));
 */
export function createBoardWsRoute(
  upgradeWebSocket: UpgradeWebSocket,
  boardEvents: BoardEvents,
) {
  return upgradeWebSocket((c: Context) => {
    const projectId = c.req.param("projectId")!;
    return {
      onOpen(_event: Event, ws: WSContext) {
        boardEvents.subscribe(projectId, ws);
      },
      onClose(_event: CloseEvent, ws: WSContext) {
        boardEvents.unsubscribe(projectId, ws);
      },
    };
  });
}
